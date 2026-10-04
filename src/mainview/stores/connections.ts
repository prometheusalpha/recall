import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { errorMessage, RPC_TIMEOUTS, rpc } from "../lib/rpc";
import type {
	ColumnInfo,
	ConnectionConfig,
	ConnectionProfile,
	ConnectionTestResult,
	DatabaseConnectionInfo,
	DatabaseInfo,
	DatabaseType,
	ForeignKeyInfo,
	IndexInfo,
	TableInfo,
	TriggerInfo,
} from "../../shared/types";
import { useTabsStore } from "./tabs";

export type ConnectionStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "error";

/** Where profiles lived before the SQLite cutover; read once, then deleted. */
const LEGACY_STORAGE_KEY = "recall.connections";

function isDatabaseType(value: unknown): value is DatabaseType {
	return value === "postgres" || value === "mysql";
}

function isStoredConfig(value: unknown): value is ConnectionProfile {
	if (!value || typeof value !== "object") return false;
	return (
		"id" in value &&
		typeof value.id === "string" &&
		value.id.length > 0 &&
		"name" in value &&
		typeof value.name === "string" &&
		"dbType" in value &&
		isDatabaseType(value.dbType) &&
		"host" in value &&
		typeof value.host === "string" &&
		"port" in value &&
		typeof value.port === "number" &&
		"username" in value &&
		typeof value.username === "string" &&
		"database" in value &&
		typeof value.database === "string" &&
		"defaultSchema" in value &&
		typeof value.defaultSchema === "string" &&
		"ssl" in value &&
		typeof value.ssl === "boolean" &&
		"urlParams" in value &&
		typeof value.urlParams === "string" &&
		"connectTimeoutSecs" in value &&
		typeof value.connectTimeoutSecs === "number" &&
		"queryTimeoutSecs" in value &&
		typeof value.queryTimeoutSecs === "number" &&
		"note" in value &&
		typeof value.note === "string" &&
		"savePassword" in value &&
		typeof value.savePassword === "boolean" &&
		"showSystemSchemas" in value &&
		typeof value.showSystemSchemas === "boolean"
	);
}

/**
 * Reads and validates the profile list the app used to keep in
 * `localStorage`. Anything malformed is dropped rather than trusted — the blob
 * is user-writable and survives across app versions, so its shape cannot be
 * assumed.
 */
function readLegacyProfiles(): ConnectionProfile[] {
	let raw: string | null;
	try {
		raw = localStorage.getItem(LEGACY_STORAGE_KEY);
	} catch {
		return [];
	}
	if (raw === null) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isStoredConfig);
}

/** Projects the profile list for the database, dropping every password. */
function toProfiles(configs: ConnectionConfig[]): ConnectionProfile[] {
	return configs.map(({ password, ...rest }) => rest);
}

/**
 * Connection profiles plus live connection state.
 *
 * Profiles live in SQLite, in the Bun process (`src/bun/connectionStore.ts`);
 * this store reads them once at startup and rewrites the whole list on every
 * change. Passwords live in the OS credential store, also owned by Bun, so no
 * database row or RPC payload ever carries one: `passwords` here is a
 * session-only cache that lets the UI tell "saved" from "not saved" and lets a
 * profile with `savePassword: false` connect with what the user typed. Bun
 * fills an empty password in from the credential store, which is what makes a
 * saved password survive a restart.
 */
export const useConnectionsStore = defineStore("connections", () => {
	const configs = ref<ConnectionConfig[]>([]);
	/** Session-only password cache, keyed by config id; empty for `savePassword: false`. */
	const passwords = ref<Record<string, string>>({});
	const activeId = ref<string | null>(null);
	const status = ref<Record<string, ConnectionStatus>>({});
	/** Server-reported identity of each live connection, keyed by config id. */
	const databaseInfo = ref<Record<string, DatabaseConnectionInfo>>({});
	/**
	 * False until the stored profiles have been read. The sidebar holds its
	 * empty state back until this flips, so a slow read cannot be mistaken for
	 * "this user has no connections".
	 */
	const hydrated = ref(false);
	/** Tail of the write chain: every `saveConnections` runs behind the last. */
	let writes: Promise<void> = Promise.resolve();
	/** In-flight (or finished) startup read; `null` until `hydrate` is called. */
	let hydration: Promise<void> | null = null;

	const connectedIds = computed(() =>
		Object.entries(status.value)
			.filter(([, value]) => value === "connected")
			.map(([id]) => id),
	);

	/**
	 * `password` overrides the session cache when the caller has one in hand —
	 * a form that typed a password this session is more current than the cache,
	 * which `savePassword: false` empties on every persist.
	 */
	function configFor(id: string, password?: string): ConnectionConfig {
		const config = configs.value.find((entry) => entry.id === id);
		if (!config) throw new Error(`Unknown connection: ${id}`);
		return {
			...config,
			password: password ?? passwords.value[id] ?? config.password,
		};
	}

	/**
	 * Asks the Bun process to drop the password it holds for this profile.
	 *
	 * Fire-and-forget on purpose: the store's own copy is already gone by the
	 * time this runs, and a keychain entry that outlives its profile is a
	 * leftover, not a broken profile. Failures must not surface in the UI.
	 */
	function forgetStoredCredential(id: string, username: string): void {
		if (!username) return;
		void rpc.request
			.forgetCredential(
				{ connectionId: id, username },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			)
			.catch(() => {});
	}

	/**
	 * Writes the profile list to SQLite. `savePassword: false` is enforced here
	 * rather than at each call site: a profile that does not save its password
	 * keeps no session cache entry, so a later `connect` from the tree must be
	 * handed a fresh one by the dialog instead of silently reusing a stale one.
	 *
	 * Writes are chained so two edits in a row reach the database in the order
	 * they were made, and each waits for hydration first. The list is read at
	 * write time rather than captured here, so a write that was queued while
	 * the profiles were still loading saves the loaded list too, not the empty
	 * one it was queued with.
	 */
	function persist(): void {
		for (const config of configs.value) {
			if (!config.savePassword) delete passwords.value[config.id];
		}
		writes = writes
			.then(() => hydration)
			.then(() =>
				rpc.request.saveConnections(
					{ configs: toProfiles(configs.value) },
					{ maxRequestTime: RPC_TIMEOUTS.metadata },
				),
			)
			.catch((err) => {
				console.error(
					"[recall] could not save connection profiles:",
					errorMessage(err),
				);
			});
	}

	/**
	 * Reads the stored profiles once per session. Safe to call from anywhere:
	 * the first caller owns the read and everyone else awaits the same promise.
	 *
 * An empty database is the one case that still has work to do — profiles saved
 * by a version that used `localStorage` are moved across, and the old blob is
	 * only deleted once the database has taken it.
	 */
	function hydrate(): Promise<void> {
		hydration ??= (async () => {
			try {
				const stored = await rpc.request.listConnections(
					{},
					{ maxRequestTime: RPC_TIMEOUTS.metadata },
				);
				if (stored.length === 0) {
					await migrateLegacyProfiles();
				} else {
					// The read can land after an edit. Stored profiles are merged
					// in around whatever the user has already touched, so an
					// in-flight change is neither lost nor overwritten by the
					// older row it was made from.
					const known = new Set(configs.value.map((entry) => entry.id));
					configs.value = [
						...stored.filter((entry) => !known.has(entry.id)),
						...configs.value,
					];
				}
			} catch (err) {
				console.error(
					"[recall] could not load connection profiles:",
					errorMessage(err),
				);
			} finally {
				hydrated.value = true;
			}
		})();
		return hydration;
	}

	async function migrateLegacyProfiles(): Promise<void> {
		const legacy = readLegacyProfiles();
		try {
			if (legacy.length > 0) {
				await rpc.request.saveConnections(
					{ configs: legacy },
					{ maxRequestTime: RPC_TIMEOUTS.metadata },
				);
			}
			localStorage.removeItem(LEGACY_STORAGE_KEY);
		} catch (err) {
			// The blob stays put: it is the only copy of these profiles until a
			// launch gets far enough to move them.
			console.error(
				"[recall] could not migrate local profiles to SQLite:",
				errorMessage(err),
			);
			return;
		}
		configs.value = legacy.map((profile) => ({ ...profile, password: "" }));
	}

	/**
	 * Registers a new profile. A password is only kept when the profile asks
	 * for it; otherwise it is dropped from both the session cache and the
	 * in-memory profile, so nothing survives for `connect` to pick up later.
	 */
	function add(config: ConnectionConfig): void {
		const entry: ConnectionConfig = { ...config };
		if (entry.savePassword) {
			if (entry.password) passwords.value[entry.id] = entry.password;
		} else {
			entry.password = "";
		}
		configs.value.push(entry);
		status.value[entry.id] = "disconnected";
		persist();
	}

	function update(id: string, patch: Partial<ConnectionConfig>): void {
		const index = configs.value.findIndex((entry) => entry.id === id);
		const previousUsername = configs.value[index].username;
		if (patch.password) passwords.value[id] = patch.password;
		// An explicit empty password means "clear the cached one".
		if (patch.password === "") delete passwords.value[id];
		const entry: ConnectionConfig = {
			...configs.value[index],
			...patch,
			id,
			password: passwords.value[id] ?? "",
		};
		// Turning `savePassword` off drops the password everywhere it was
		// kept; the form that just saved it is the only holder left. The
		// credential store was the other place it lived, so it goes too.
		if (!entry.savePassword) {
			delete passwords.value[id];
			entry.password = "";
			forgetStoredCredential(id, previousUsername);
		}
		// A credential is filed under its username, so a renamed user leaves
		// the old entry stranded under a name nothing will look up again.
		if (entry.username !== previousUsername) {
			forgetStoredCredential(id, previousUsername);
		}
		configs.value[index] = entry;
		persist();
	}

	async function remove(id: string): Promise<void> {
		const config = configs.value.find((entry) => entry.id === id);
		if (status.value[id] === "connected") await disconnect(id);
		if (config) forgetStoredCredential(id, config.username);
		configs.value = configs.value.filter((entry) => entry.id !== id);
		delete passwords.value[id];
		delete status.value[id];
		delete databaseInfo.value[id];
		if (activeId.value === id) activeId.value = null;
		persist();
	}

	/**
	 * `password` is the one the form is holding right now. It is passed through
	 * unchanged, so a profile with `savePassword: false` — whose cache entry was
	 * dropped on save — still connects with what the user typed this session.
	 */
	async function connect(
		id: string,
		password?: string,
	): Promise<DatabaseConnectionInfo> {
		const config = configFor(id, password);
		status.value[id] = "connecting";
		try {
			const result = await rpc.request.connect(
				{ config },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
			databaseInfo.value[id] = result.databaseInfo;
			status.value[id] = "connected";
			activeId.value = id;
			return result.databaseInfo;
		} catch (err) {
			status.value[id] = "error";
			throw new Error(errorMessage(err));
		}
	}

	/**
	 * Drops the backend session and the local state that described it, leaving
	 * tab lifetime alone. Callers that are *ending* a connection rather than
	 * restarting one use `disconnect`, which is this plus the tab sweep.
	 */
	async function closeSession(id: string): Promise<void> {
		try {
			await rpc.request.disconnect(
				{ connectionId: id },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
		} catch {
			// The backend may already consider the socket dead; the local state
			// is cleared regardless so the UI cannot get stuck on `connected`.
		}
		status.value[id] = "disconnected";
		delete databaseInfo.value[id];
		if (activeId.value === id) activeId.value = null;
	}

	/**
	 * Records a session the backend saw die under it.
	 *
	 * The pool drops the dead socket on its own, so without this the profile
	 * would keep saying `connected` while every request against it failed with
	 * "No open connection" — and `ensureConnected`, which trusts that status,
	 * would keep skipping the reconnect. Marking it `disconnected` hands the
	 * next query path a real connect to make.
	 *
	 * A profile with a database-scoped driver can lose a secondary session
	 * while its primary is still up. `disconnected` is the conservative answer
	 * for that: the next request reconnects the profile, which is a no-op in
	 * effect and reopens the dead database's session on the way.
	 */
	function markLost(id: string): void {
		if (status.value[id] === undefined) return;
		status.value[id] = "disconnected";
		delete databaseInfo.value[id];
		if (activeId.value === id) activeId.value = null;
	}

	async function disconnect(id: string): Promise<void> {
		await closeSession(id);
		// Connections own tab lifetime: a tab whose connection is gone is dead.
		useTabsStore().closeForConnection(id);
	}

	/**
	 * Drops the current session and opens a fresh one in its place.
	 *
	 * The teardown goes through `closeSession`, not `disconnect`, so the user's
	 * tabs survive: a reconnect ends with the profile connected again, and every
	 * query path re-asserts the connection through `ensureConnected`, so a tab
	 * left standing is live rather than dead. Sweeping them here would throw
	 * away the user's work to rebuild a session that is about to exist anyway.
	 *
	 * A profile already sitting in `error` or `disconnected` has no session to
	 * drop, so the teardown is skipped entirely. The connect failure is
	 * deliberately not caught: `connect` has already recorded `error` on the
	 * profile, and swallowing the reason here would leave the caller with no way
	 * to tell a failed reconnect from a success.
	 */
	async function reconnect(id: string): Promise<void> {
		if (status.value[id] === "connected") await closeSession(id);
		await connect(id);
	}

	async function test(config: ConnectionConfig): Promise<ConnectionTestResult> {
		// The form's own password wins; only a profile that saves its password
		// may fall back to the session cache when the field was left blank.
		const resolved: ConnectionConfig = {
			...config,
			password:
				config.password || (config.savePassword
					? (passwords.value[config.id] ?? "")
					: ""),
		};
		return rpc.request.testConnection(
			{ config: resolved },
			{ maxRequestTime: RPC_TIMEOUTS.metadata },
		);
	}

	/**
	 * Brings a profile up before anyone asks the backend to use it.
	 *
	 * A table tab restored from disk runs its first `listColumns` while the
	 * startup profile read is still in flight, and `connect` resolves the
	 * profile out of `configs` — which is empty until that read lands. So the
	 * profile list is awaited here first. `hydrate` owns its own promise, so
	 * joining it late starts the same single read rather than a second one,
	 * and it resolves rather than rejects, leaving the connect error — the one
	 * callers surface — as the only failure this can report.
	 */
	async function ensureConnected(id: string): Promise<void> {
		if (status.value[id] === "connected") return;
		await (hydration ?? hydrate());
		await connect(id);
	}

	async function listDatabases(id: string): Promise<DatabaseInfo[]> {
		try {
			return await rpc.request.listDatabases(
				{ connectionId: id },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
		} catch (err) {
			throw new Error(errorMessage(err));
		}
	}

	async function listSchemas(params: {
		connectionId: string;
		database: string;
	}): Promise<string[]> {
		try {
			return await rpc.request.listSchemas(params, {
				maxRequestTime: RPC_TIMEOUTS.metadata,
			});
		} catch (err) {
			throw new Error(errorMessage(err));
		}
	}

	async function listTables(params: {
		connectionId: string;
		database: string;
		schema: string;
		filter?: string;
	}): Promise<TableInfo[]> {
		try {
			return await rpc.request.listTables(
				{ ...params, filter: params.filter ?? "" },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
		} catch (err) {
			throw new Error(errorMessage(err));
		}
	}

	async function listColumns(params: {
		connectionId: string;
		database: string;
		schema: string;
		table: string;
	}): Promise<ColumnInfo[]> {
		try {
			return await rpc.request.listColumns(params, {
				maxRequestTime: RPC_TIMEOUTS.metadata,
			});
		} catch (err) {
			throw new Error(errorMessage(err));
		}
	}

	async function listIndexes(params: {
		connectionId: string;
		database: string;
		schema: string;
		table: string;
	}): Promise<IndexInfo[]> {
		try {
			return await rpc.request.listIndexes(params, {
				maxRequestTime: RPC_TIMEOUTS.metadata,
			});
		} catch (err) {
			throw new Error(errorMessage(err));
		}
	}

	async function listTriggers(params: {
		connectionId: string;
		database: string;
		schema: string;
		table: string;
	}): Promise<TriggerInfo[]> {
		try {
			return await rpc.request.listTriggers(params, {
				maxRequestTime: RPC_TIMEOUTS.metadata,
			});
		} catch (err) {
			throw new Error(errorMessage(err));
		}
	}

	async function listForeignKeys(params: {
		connectionId: string;
		database: string;
		schema: string;
		table: string;
	}): Promise<ForeignKeyInfo[]> {
		try {
			return await rpc.request.listForeignKeys(params, {
				maxRequestTime: RPC_TIMEOUTS.metadata,
			});
		} catch (err) {
			throw new Error(errorMessage(err));
		}
	}

	async function tableDdl(params: {
		connectionId: string;
		database: string;
		schema: string;
		table: string;
	}): Promise<string> {
		try {
			return await rpc.request.tableDdl(params, {
				maxRequestTime: RPC_TIMEOUTS.metadata,
			});
		} catch (err) {
			throw new Error(errorMessage(err));
		}
	}

	return {
		configs,
		passwords,
		activeId,
		status,
		databaseInfo,
		hydrated,
		connectedIds,
		hydrate,
		add,
		update,
		remove,
		connect,
		disconnect,
		reconnect,
		markLost,
		test,
		ensureConnected,
		listDatabases,
		listSchemas,
		listTables,
		listColumns,
		listIndexes,
		listTriggers,
		listForeignKeys,
		tableDdl,
	};
});
