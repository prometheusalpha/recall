import { SQL } from "bun";
import type { ConnectionConfig } from "../shared/types";
import { credentialStore } from "./credentialStore";
import { driverFor, normalizeBackendError } from "./driver";

export interface LiveConnection {
	config: ConnectionConfig;
	db: SQL;
	connectedAt: number;
	/** The profile this session belongs to; several sessions share one. */
	connectionId: string;
	/** The session opened by `connect`, as opposed to one opened per database. */
	primary: boolean;
}

const connections = new Map<string, LiveConnection>();
/** Opens in flight, so two requests for one database share a single session. */
const opening = new Map<string, Promise<LiveConnection>>();

/**
 * Length-prefixes the parts so two ids that differ only in their database name
 * — or a database literally named like a key — cannot land on one entry.
 */
function poolKey(connectionId: string, database: string): string {
	return `${connectionId.length}:${connectionId}${database}`;
}

/**
 * Store a password in the OS credential store.
 *
 * The username is the Keychain account name, so a profile whose user changed
 * cannot read back the old secret. Delegates to {@link credentialStore},
 * which never throws and degrades to "nothing stored" when the OS store is
 * unavailable.
 */
export async function saveCredential(
	connectionId: string,
	username: string,
	password: string,
): Promise<void> {
	await credentialStore.save(connectionId, username, password);
}

/** Read a stored password, or null when none is saved. */
export async function loadCredential(
	connectionId: string,
	username: string,
): Promise<string | null> {
	return credentialStore.load(connectionId, username);
}

/** Remove a stored password. Safe to call when nothing is stored. */
export async function forgetCredential(
	connectionId: string,
	username: string,
): Promise<void> {
	await credentialStore.remove(connectionId, username);
}

type ConnectionLostListener = (connectionId: string, reason: string) => void;

const connectionLostListeners = new Set<ConnectionLostListener>();

/** Subscribe to unexpected connection loss; returns an unsubscribe function. */
export function onConnectionLost(
	listener: ConnectionLostListener,
): () => void {
	connectionLostListeners.add(listener);
	return () => connectionLostListeners.delete(listener);
}

function notifyConnectionLost(connectionId: string, reason: string): void {
	for (const listener of connectionLostListeners) {
		listener(connectionId, reason);
	}
}

/**
 * Open a live session. Pings before registering so a bad config never lands in
 * the pool, and always closes the SQL handle when the ping fails so no socket
 * is leaked. Replaces only the session for the same profile *and* database, so
 * reconnecting one database never drops the others.
 */
export async function openConnection(
	cfg: ConnectionConfig,
	primary: boolean,
): Promise<LiveConnection> {
	const key = poolKey(cfg.id, cfg.database);
	const existing = connections.get(key);
	if (existing) await closeSession(existing);

	const driver = driverFor(cfg.dbType);
	let db: SQL;
	try {
		// `onclose` fires when the pooled socket dies under us; the renderer
		// needs to hear about it even though no RPC call triggered it.
		const options = driver.buildOptions(cfg);
		db = new SQL({
			...options,
			onclose: (error: Error | null) => {
				if (connections.get(key) === undefined) return;
				connections.delete(key);
				notifyConnectionLost(
					cfg.id,
					error?.message ?? "The database connection closed unexpectedly.",
				);
			},
		});
	} catch (error) {
		throw normalizeBackendError(error);
	}

	try {
		await driver.ping(db);
	} catch (error) {
		try {
			await db.close({ timeout: 1 });
		} catch {
			// The handle is already broken; nothing else to release.
		}
		throw normalizeBackendError(error);
	}

	const live: LiveConnection = {
		config: cfg,
		db,
		connectedAt: Date.now(),
		connectionId: cfg.id,
		primary,
	};
	connections.set(key, live);
	return live;
}

/** The session `connect` opened for this profile, or undefined. */
function primaryOf(connectionId: string): LiveConnection | undefined {
	for (const live of connections.values()) {
		if (live.connectionId === connectionId && live.primary) return live;
	}
	return undefined;
}

/** Every session of a profile, in insertion order. */
function sessionsOf(connectionId: string): LiveConnection[] {
	return [...connections.values()].filter(
		(live) => live.connectionId === connectionId,
	);
}

/**
 * The profile's own session, for requests that are about the *server* rather
 * than one of its databases. Listing databases is such a request: Postgres
 * answers it from `pg_database`, which any database on the server can read.
 */
export function getServerConnection(connectionId: string): LiveConnection {
	const primary = primaryOf(connectionId);
	if (!primary) {
		throw new Error(
			`No open connection for id "${connectionId}". It was never connected or has already been disconnected.`,
		);
	}
	return primary;
}

/**
 * The session that can answer a request for `database`.
 *
 * MySQL reaches any database from the profile's one session, so that is what
 * every request gets. Postgres is pinned to a database at connect time, so a
 * request naming another one opens its own session from the primary's config —
 * the password the renderer never holds lives on that config — and reuses it
 * for every later request against the same database.
 */
export async function getConnection(
	connectionId: string,
	database: string,
): Promise<LiveConnection> {
	const primary = primaryOf(connectionId);
	if (!primary) {
		throw new Error(
			`No open connection for id "${connectionId}". It was never connected or has already been disconnected.`,
		);
	}
	if (!driverFor(primary.config.dbType).databaseScoped) return primary;
	if (primary.config.database === database) return primary;

	const key = poolKey(connectionId, database);
	const existing = connections.get(key);
	if (existing) return existing;
	const pending = opening.get(key);
	if (pending) return pending;

	const config: ConnectionConfig = { ...primary.config, database };
	const promise = openConnection(config, false).finally(() => {
		opening.delete(key);
	});
	opening.set(key, promise);
	return promise;
}

export function isConnected(connectionId: string): boolean {
	return primaryOf(connectionId) !== undefined;
}

export function activeConnectionIds(): string[] {
	const ids: string[] = [];
	for (const live of connections.values()) {
		if (!ids.includes(live.connectionId)) ids.push(live.connectionId);
	}
	return ids;
}

/** Close one session and forget it. Idempotent. */
async function closeSession(live: LiveConnection): Promise<void> {
	connections.delete(poolKey(live.connectionId, live.config.database));
	try {
		await live.db.close({ timeout: 5 });
	} catch (error) {
		console.warn(
			`[recall] error closing connection ${live.connectionId}/${live.config.database}:`,
			error instanceof Error ? error.message : error,
		);
	}
}

/** Close every session of a profile. Idempotent. */
export async function closeConnection(connectionId: string): Promise<void> {
	await Promise.all(sessionsOf(connectionId).map(closeSession));
}

/** Close every open connection; used on app shutdown. */
export async function closeAllConnections(): Promise<void> {
	await Promise.all([...connections.values()].map(closeSession));
}