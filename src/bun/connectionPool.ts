import { SQL } from "bun";
import type { SqlConnectionConfig } from "../shared/types";
import { credentialStore } from "./credentialStore";
import { driverFor, normalizeBackendError } from "./driver";

export interface LiveConnection {
	config: SqlConnectionConfig;
	db: SQL;
	connectedAt: number;
	/** The profile this session belongs to; several sessions share one. */
	connectionId: string;
	/** The session opened by `connect`, as opposed to one opened per database. */
	primary: boolean;
	/** Statements handed out on this session that have not settled yet. */
	inFlight: number;
	/** When the last statement on it settled, or when it was opened. */
	idleSince: number;
}

const connections = new Map<string, LiveConnection>();
/** Opens in flight, so two requests for one database share a single session. */
const opening = new Map<string, Promise<LiveConnection>>();
/**
 * Probes in flight, keyed by the session being probed. The probe's own ping
 * counts as in flight, so without this a request arriving mid-probe reads the
 * session as busy and is handed the socket the probe is about to condemn.
 */
const probing = new Map<LiveConnection, Promise<LiveConnection>>();

/**
 * Profile configs, kept past the sessions they opened.
 *
 * A session that dies takes its config with it, and the config is the only
 * thing that can open the next one: the password lives on it and the renderer
 * holds none. Keeping it until the user disconnects is what lets a request
 * reopen its own session instead of failing on a socket nobody was left to
 * replace.
 */
const profiles = new Map<string, SqlConnectionConfig>();

/**
 * How long a session may sit unused before the next request probes it first.
 *
 * A socket reaped by a NAT or a firewall leaves no FIN and no RST, so nothing
 * reports it: the pool keeps the session and the profile keeps reading as
 * connected. The first statement after that writes into the void and waits out
 * the kernel's whole retransmission budget — a minute or more — before failing.
 *
 * Five seconds is well under the idle timers that reap a flow in practice
 * (routers and firewalls start around thirty) and the probe only runs on a
 * session nothing is using, so the one round trip it costs lands while the user
 * is waiting for nothing.
 */
const IDLE_PROBE_AFTER_MS = 5_000;
/** How long a probe may take before its session counts as gone. */
const IDLE_PROBE_CAP_MS = 5_000;

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
	cfg: SqlConnectionConfig,
	primary: boolean,
): Promise<LiveConnection> {
	const key = poolKey(cfg.id, cfg.database);
	const existing = connections.get(key);
	if (existing) await closeSession(existing);

	const driver = driverFor(cfg.dbType);
	let db: SQL;
	// Assigned once the session is registered; `onclose` runs later than that
	// in every normal case, and the guard below covers the one that is not.
	let live: LiveConnection | undefined;
	try {
		// `onclose` fires when the pooled socket dies under us; the renderer
		// needs to hear about it even though no RPC call triggered it.
		const options = driver.buildOptions(cfg);
		db = new SQL({
			...options,
			onclose: (error: Error | null) => {
				// Compare identity, not existence: a session replaced after a
				// failed probe has its socket closed *after* the replacement is
				// registered, and its callback arriving late must not speak for
				// the session that now owns the key — doing so drops a healthy
				// session and raises a "lost" toast the user never earned.
				if (live === undefined || connections.get(key) !== live) return;
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

	live = {
		config: cfg,
		db,
		connectedAt: Date.now(),
		connectionId: cfg.id,
		primary,
		inFlight: 0,
		idleSince: Date.now(),
	};
	trackInFlight(live);
	// Only the profile's own session is reachable from a config alone: a
	// per-database session is derived from the primary one, and that is where
	// the config no request ever sees was stored.
	if (primary) profiles.set(cfg.id, cfg);
	connections.set(key, live);
	return live;
}

/**
 * Count the statements running on a session.
 *
 * Bun's handle is shared rather than checked out, so nothing else knows whether
 * a session is mid-statement — and that is what decides whether probing it is
 * safe. Every statement the app runs goes through `db.unsafe`: the drivers
 * build their metadata SQL there and the query handler runs user SQL there, so
 * one wrapper covers all of them.
 */
function trackInFlight(live: LiveConnection): void {
	const native = live.db.unsafe.bind(live.db);
	live.db.unsafe = function tracked<T = unknown>(
		statement: string,
		values?: unknown[] | Record<string, unknown>,
	): SQL.Query<T> {
		live.inFlight += 1;
		const query = native<T>(statement, values);
		const settle = (): void => {
			live.inFlight -= 1;
			live.idleSince = Date.now();
		};
		// Both outcomes settle the same way: what the pool needs is when the
		// session went quiet, not how the statement ended.
		query.then(settle, settle);
		return query;
	};
}

/**
 * True when the session answers in time.
 *
 * The probe is the driver's own ping, so it is dialect-correct for free. A
 * socket that never answers leaves the probe pending past the cap, so its own
 * failure is swallowed: the caller is about to drop that session, and a late
 * rejection is nothing the pool can act on.
 */
async function probeAlive(live: LiveConnection): Promise<boolean> {
	const probe = driverFor(live.config.dbType).ping(live.db);
	probe.catch(() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), IDLE_PROBE_CAP_MS);
	});
	try {
		return await Promise.race([
			probe.then(
				() => true,
				() => false,
			),
			expired,
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Hand a session to a request, replacing it first when it has sat idle long
 * enough for the network to have reaped it.
 *
 * Only an idle session is probed: while a statement is running its socket is
 * busy rather than dead, and a probe queued behind that statement would look
 * like a timeout on a session that is simply working.
 */
async function handOut(live: LiveConnection): Promise<LiveConnection> {
	const pending = probing.get(live);
	if (pending) return pending;
	if (live.inFlight > 0 || Date.now() - live.idleSince < IDLE_PROBE_AFTER_MS) {
		return live;
	}
	const check = (async () => {
		if (await probeAlive(live)) {
			live.idleSince = Date.now();
			return live;
		}
		return replace(live);
	})().finally(() => probing.delete(live));
	probing.set(live, check);
	return check;
}

/** Swap a session that failed its probe for a fresh one from its config. */
async function replace(live: LiveConnection): Promise<LiveConnection> {
	const key = poolKey(live.connectionId, live.config.database);
	const pending = opening.get(key);
	if (pending) return pending;
	const promise = (async () => {
		// Another caller may have replaced it while this probe was in flight;
		// closing a session the pool no longer owns would kill the request it
		// has already been handed to.
		//
		// The close is not awaited: a socket that just failed a probe takes its
		// whole close timeout to go away, and the request that found it should
		// not wait that out — the pool has already forgotten the session, and
		// `closeSession` deletes it before it starts closing.
		if (connections.get(key) === live) void closeSession(live);
		return openConnection(live.config, live.primary);
	})().finally(() => opening.delete(key));
	opening.set(key, promise);
	return promise;
}

/**
 * The profile's own session, reopened from its stored config when the socket
 * under it died. Concurrent requests share the one open, so a reaped socket
 * costs one replacement instead of one per request.
 */
async function openPrimary(connectionId: string): Promise<LiveConnection> {
	const live = primaryOf(connectionId);
	if (live) return live;

	const config = profiles.get(connectionId);
	if (!config) {
		throw new Error(
			`No open connection for id "${connectionId}". It was never connected or has already been disconnected.`,
		);
	}

	const key = poolKey(connectionId, config.database);
	const pending = opening.get(key);
	if (pending) return pending;
	const promise = openConnection(config, true).finally(() =>
		opening.delete(key),
	);
	opening.set(key, promise);
	return promise;
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
export async function getServerConnection(
	connectionId: string,
): Promise<LiveConnection> {
	return handOut(await openPrimary(connectionId));
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
	const primary = await handOut(await openPrimary(connectionId));
	if (!driverFor(primary.config.dbType).databaseScoped) return primary;
	return sessionIn(primary, database);
}

/**
 * The session for running the user's own SQL against `database`.
 *
 * Unqualified names in an editor resolve against the session's current
 * database, so even MySQL needs a session opened *in* the tab's database. A
 * `USE` on the shared handle would not do: Bun pools several sockets behind it
 * and the next statement can land on one that never saw the `USE`.
 */
export async function getQueryConnection(
	connectionId: string,
	database: string,
): Promise<LiveConnection> {
	const primary = await handOut(await openPrimary(connectionId));
	// A MySQL tab with no database picked runs where the profile's default
	// puts it, as it always has.
	if (database === "" && !driverFor(primary.config.dbType).databaseScoped) {
		return primary;
	}
	return sessionIn(primary, database);
}

async function sessionIn(
	primary: LiveConnection,
	database: string,
): Promise<LiveConnection> {
	if (primary.config.database === database) return primary;

	const key = poolKey(primary.connectionId, database);
	const existing = connections.get(key);
	if (existing) return handOut(existing);
	const pending = opening.get(key);
	if (pending) return pending;

	const config: SqlConnectionConfig = { ...primary.config, database };
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
	// Forgetting the config is what makes an explicit disconnect stick: a pool
	// that kept it would reopen the session on the next request.
	profiles.delete(connectionId);
	await Promise.all(sessionsOf(connectionId).map(closeSession));
}

/** Close every open connection; used on app shutdown. */
export async function closeAllConnections(): Promise<void> {
	profiles.clear();
	await Promise.all([...connections.values()].map(closeSession));
}