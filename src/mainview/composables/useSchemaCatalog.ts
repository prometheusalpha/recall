/**
 * Column cache for editor autocomplete.
 *
 * Completion runs on every keystroke, so columns cannot be re-listed per
 * keystroke. This keeps one short-lived record per (connection, database,
 * schema, table) plus a single in-flight promise per key, so a burst of typing
 * costs exactly one `listColumns` RPC.
 *
 * Caches are module-level — one per window — while the store is resolved inside
 * {@link useSchemaCatalog}: this file is imported before
 * `createApp().use(createPinia())` runs.
 */
import { ref, type Ref } from "vue";
import type { ColumnInfo } from "../../shared/types";
import { useConnectionsStore } from "../stores/connections";

/** The (connection, database, schema, table) a column list belongs to. */
export interface SchemaKey {
	connectionId: string;
	database: string;
	schema: string;
	table: string;
}

/** One cached column list, with the moment it was fetched. */
interface CachedColumns {
	columns: ColumnInfo[];
	fetchedAt: number;
	/** A failed list is cached too, but only for a moment. */
	failed: boolean;
}

/**
 * Same authority window as the table catalog's `CATALOG_TTL_MS` (5 minutes):
 * a column list is as stale as a table list, and one session's worth of typing
 * should cost one RPC per table.
 */
const SCHEMA_TTL_MS = 5 * 60_000;

/**
 * A failed list is cached like a good one, so a burst of typing cannot become a
 * burst of RPCs. It expires far sooner: one dropped socket used to black out
 * completions for five minutes, and the connection is usually back in seconds.
 */
const FAILURE_TTL_MS = 10_000;

/** Whether a cached list is still worth answering with. */
function isFresh(entry: CachedColumns): boolean {
	return Date.now() - entry.fetchedAt < (entry.failed ? FAILURE_TTL_MS : SCHEMA_TTL_MS);
}

/** Cached columns, keyed by the four-part scope. */
const columnsByTable = new Map<string, CachedColumns>();

/** One `listColumns` per key, shared by every caller that asks meanwhile. */
const inFlight = new Map<string, Promise<ColumnInfo[]>>();

/**
 * Bumped whenever a cache entry lands. The cache is a plain Map, so reactive
 * consumers need something to depend on.
 */
const cacheVersion = ref(0);

/** Length-prefixed so `ab`/`c` can never collide with `a`/`bc`. */
function keyOf(key: SchemaKey): string {
	const { connectionId, database, schema, table } = key;
	return `${connectionId.length}:${connectionId}${database.length}:${database}${schema.length}:${schema}${table.length}:${table}`;
}

/** What the editor reads out of the cache. */
export interface SchemaCatalog {
	/**
	 * Columns for one table, fetched at most once per TTL window. Never rejects:
	 * a dropped connection must not surface as an exception inside completion.
	 */
	columnsFor(key: SchemaKey): Promise<ColumnInfo[]>;
	/** What is already cached; empty while cold or expired. */
	cachedColumns(key: SchemaKey): ColumnInfo[];
	/** Bumped whenever cached columns change. */
	version: Ref<number>;
	/** Drops every entry — tab closed, connection reset. */
	invalidate(): void;
	/** Drops one connection's entries after its socket dies. */
	invalidateConnection(connectionId: string): void;
}

/**
 * Resolves `connections` per call — this module is imported before pinia is
 * installed — while the caches stay module-level, so the editor and the grid
 * share one session's worth of column lists.
 */
export function useSchemaCatalog(): SchemaCatalog {
	const connections = useConnectionsStore();

	/**
	 * Resolves to the cached columns, the in-flight promise for the same key, or
	 * one new fetch. A failure resolves to `[]` *and is cached*, so a connection
	 * that is down does not re-attempt the RPC on every keystroke; the TTL then
	 * lets it recover on its own.
	 */
	function columnsFor(key: SchemaKey): Promise<ColumnInfo[]> {
		const cacheKey = keyOf(key);
		const cached = columnsByTable.get(cacheKey);
		if (cached && isFresh(cached)) {
			return Promise.resolve(cached.columns);
		}
		const pending = inFlight.get(cacheKey);
		if (pending) return pending;

		// The backend answers only for a session `connect()` opened, so a tab
		// restored from disk must connect before it lists anything.
		const request = connections
			.ensureConnected(key.connectionId)
			.then(() =>
				connections.listColumns({
					connectionId: key.connectionId,
					database: key.database,
					schema: key.schema,
					table: key.table,
				}),
			)
			.then((columns) => {
				columnsByTable.set(cacheKey, {
					columns,
					fetchedAt: Date.now(),
					failed: false,
				});
				return columns;
			})
			.catch(() => {
				// Cached like a success, with no columns: the popup simply has
				// nothing to offer until {@link FAILURE_TTL_MS} runs out.
				columnsByTable.set(cacheKey, {
					columns: [],
					fetchedAt: Date.now(),
					failed: true,
				});
				return [] as ColumnInfo[];
			})
			.finally(() => {
				inFlight.delete(cacheKey);
				cacheVersion.value += 1;
			});
		inFlight.set(cacheKey, request);
		return request;
	}

	function cachedColumns(key: SchemaKey): ColumnInfo[] {
		const entry = columnsByTable.get(keyOf(key));
		return entry && isFresh(entry) ? entry.columns : [];
	}

	function invalidate(): void {
		columnsByTable.clear();
		inFlight.clear();
		cacheVersion.value += 1;
	}

	/**
	 * Drops one connection's lists, leaving every other connection's alone.
	 *
	 * Keys are length-prefixed, so the connection's own prefix can never be the
	 * prefix of another id. The in-flight map is left running: a fetch started
	 * before the socket died answers with columns the schema still has.
	 */
	function invalidateConnection(connectionId: string): void {
		if (!connectionId) return;
		const prefix = `${connectionId.length}:${connectionId}`;
		for (const cacheKey of [...columnsByTable.keys()]) {
			if (cacheKey.startsWith(prefix)) columnsByTable.delete(cacheKey);
		}
		cacheVersion.value += 1;
	}

	return {
		columnsFor,
		cachedColumns,
		version: cacheVersion,
		invalidate,
		invalidateConnection,
	};
}
