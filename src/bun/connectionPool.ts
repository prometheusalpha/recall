import { SQL } from "bun";
import type { ConnectionConfig } from "../shared/types";
import { credentialStore } from "./credentialStore";
import { driverFor, normalizeBackendError } from "./driver";

export interface LiveConnection {
	config: ConnectionConfig;
	db: SQL;
	connectedAt: number;
}

const connections = new Map<string, LiveConnection>();

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
 * Open a live connection. Pings before registering so a bad config never lands
 * in the pool, and always closes the SQL handle when the ping fails so no
 * socket is leaked.
 */
export async function openConnection(
	cfg: ConnectionConfig,
): Promise<LiveConnection> {
	if (connections.has(cfg.id)) {
		await closeConnection(cfg.id);
	}

	const driver = driverFor(cfg.dbType);
	let db: SQL;
	try {
		// `onclose` fires when the pooled socket dies under us; the renderer
		// needs to hear about it even though no RPC call triggered it.
		const options = driver.buildOptions(cfg);
		db = new SQL({
			...options,
			onclose: (error: Error | null) => {
				if (!connections.delete(cfg.id)) return;
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
	};
	connections.set(cfg.id, live);
	return live;
}

/** Fetch a live connection, throwing a normalized error when it is absent. */
export function getConnection(connectionId: string): LiveConnection {
	const live = connections.get(connectionId);
	if (!live) {
		throw new Error(
			`No open connection for id "${connectionId}". It was never connected or has already been disconnected.`,
		);
	}
	return live;
}

export function isConnected(connectionId: string): boolean {
	return connections.has(connectionId);
}

export function activeConnectionIds(): string[] {
	return [...connections.keys()];
}

/** Close and forget a connection. Idempotent. */
export async function closeConnection(connectionId: string): Promise<void> {
	const live = connections.get(connectionId);
	if (!live) return;
	connections.delete(connectionId);
	try {
		await live.db.close({ timeout: 5 });
	} catch (error) {
		console.warn(
			`[recall] error closing connection ${connectionId}:`,
			error instanceof Error ? error.message : error,
		);
	}
}

/** Close every open connection; used on app shutdown. */
export async function closeAllConnections(): Promise<void> {
	await Promise.all(activeConnectionIds().map(closeConnection));
}