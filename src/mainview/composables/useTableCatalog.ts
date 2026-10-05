/**
 * The table catalog Quick Open searches: one session-long record per connection
 * of every (database, schema) it has enumerated. Split out of `useQuickOpen`
 * because enumeration needs `connections` and nothing else.
 *
 * The state is module-level for invariant 12's reason: the window shell opens
 * the palette and the dialog renders it, and they share one cache. The store is
 * resolved inside {@link useTableCatalog}: this file is imported before
 * `createApp().use(createPinia())` runs.
 */
import { ref, type Ref } from "vue";
import type {
	ConnectionConfig,
	DatabaseInfo,
	TableInfo,
} from "../../shared/types";
import { useConnectionsStore } from "../stores/connections";
import { errorMessage } from "../lib/rpc";
import { toast } from "./useToast";

/**
 * One (database, schema)'s fetched tables, with where the fetch ran. Both are
 * captured at fetch time rather than re-read from the config when the row is
 * built: a profile can be edited mid-session, and a row claiming the *new*
 * database would open a table that does not live there.
 */
export interface CachedTables {
	database: string;
	schema: string;
	tables: TableInfo[];
}

/**
 * Everything one connection's search has discovered. The three levels are cached
 * *together* because caching only the leaves would still re-issue the
 * enumeration on every keystroke — the cost this bounds in the first place.
 */
interface DiscoveredCatalog {
	/** When this chain was enumerated. Every level is as stale as this stamp. */
	fetchedAt: number;
	/**
	 * False while any database or schema failed. The record is kept anyway, so
	 * rows that did land stay searchable, and the next search retries the chain
	 * without re-listing the scopes that already answered.
	 */
	complete: boolean;
	/** `listDatabases`, in the order the search will chase them. */
	databases: string[];
	/**
	 * `listSchemas` per database, empty for MySQL: there the schema *is* the
	 * database (`drivers/mysql.ts` answers `[]`), which is why the two dialects
	 * are walked by separate branches rather than by a shared guess.
	 */
	schemas: Map<string, string[]>;
	/** Tables per (database, schema), keyed by {@link scopeKey}. */
	tables: Map<string, CachedTables>;
}

/**
 * What the palette has discovered, keyed by connection id because the id is the
 * profile's identity: a connection *is* one server, and which databases live
 * below it is that server's to answer.
 *
 * A record lives for the session, so a second search issues no enumeration at
 * all, but it expires on {@link CATALOG_TTL_MS} — otherwise a user who ran
 * `CREATE TABLE` and searched for the new name would read the cache as "search
 * is broken again".
 */
const catalogs = new Map<string, DiscoveredCatalog>();

/**
 * How long a catalog stays authoritative. Long enough that one working
 * session's worth of searches costs one enumeration per connection, short
 * enough that a table created five minutes ago is findable.
 */
const CATALOG_TTL_MS = 5 * 60_000;

/**
 * Fan-out caps. The database cap is really a *socket* cap: `driver.databaseScoped`
 * is true for Postgres, so naming a database the session is not in opens that
 * database's own session. Twenty is far above a real server (a stock Postgres
 * contributes three) and low enough that one profile cannot turn a keystroke
 * into a connection storm; schemas share their database's session, so fifty is
 * generous. What the cap costs is stated: a table past it is not in the palette,
 * and stays one sidebar expand away.
 */
const MAX_DATABASES_PER_CONNECTION = 20;
const MAX_SCHEMAS_PER_DATABASE = 50;

/**
 * Cache key for one (database, schema), length-prefixed as
 * `connectionPool.poolKey` is and for its reason: both parts are user-chosen
 * identifiers, so a bare join would let two pairs collapse onto one entry —
 * exactly the "opens a table that is not there" failure `CachedTables` prevents.
 */
function scopeKey(database: string, schema: string): string {
	return `${database.length}:${database}${schema}`;
}

/**
 * Whether any connection has produced tables this session. A scope that answered
 * with *zero* tables still counts: the server was reached, which is exactly what
 * {@link reportFanOut} tells apart from a server never reached at all.
 */
function anyTablesCached(): boolean {
	for (const catalog of catalogs.values()) {
		if (catalog.tables.size > 0) return true;
	}
	return false;
}

/**
 * The databases one search chases, in order: the profile's own database first
 * when the server lists it, then the rest as the server returned them. Its own
 * first because that is the database the connection dialog tested, the sidebar
 * expands and every query so far were pointed at — and on Postgres it is
 * answered by the session `connect()` already opened, so it costs nothing.
 */
function databasesToChase(
	config: ConnectionConfig,
	found: DatabaseInfo[],
): string[] {
	const names = found
		.map((entry) => entry.name)
		.filter((name) => name.length > 0);
	const own = config.database;
	const ordered =
		own.length > 0 && names.includes(own)
			? [own, ...names.filter((name) => name !== own)]
			: names;
	return ordered.slice(0, MAX_DATABASES_PER_CONNECTION);
}

/**
 * The schemas to list for one Postgres database: the profile's own schema
 * first, for the same reason, and — when the server lists none —
 * `defaultSchema` falling back to `"public"`. That fallback is no longer a guess
 * about a *database*, which is what the old one was; it is a role that cannot
 * read `information_schema.schemata`. A schema that does not exist returns zero
 * rows and no error, so the fallback is the difference between "no such schema"
 * and "your tables are right here".
 */
function schemasToChase(config: ConnectionConfig, found: string[]): string[] {
	const own = config.defaultSchema || "public";
	const names = found.length > 0 ? found : [own];
	const ordered = names.includes(own)
		? [own, ...names.filter((name) => name !== own)]
		: names;
	return ordered.slice(0, MAX_SCHEMAS_PER_DATABASE);
}

/**
 * Why the last enumeration of a connection failed, keyed by connection id, for
 * the current fan-out round. Never consulted while rendering — it exists so the
 * palette can name a reason instead of leaving an empty list unexplained, and so
 * a *failed* connection stays distinguishable from an unattempted one.
 */
const fetchErrors = new Map<string, string>();

/**
 * True once a fan-out round has told the user Quick Open cannot reach anything.
 * A module flag rather than a per-round local because the round is itself
 * repeated — every pause in typing re-issues it — and the condition does not
 * change until a connection answers.
 */
let reportFanOutFired = false;

/**
 * Connections with an enumeration in flight, so a burst of keystrokes is one
 * fan-out rather than one per character. Per connection, not per scope: a
 * connection's scopes are chased together inside one walk, and a second walk
 * would only duplicate queries the first is still making.
 */
const inFlight = new Set<string>();

/**
 * Bumped on every scope that lands. The catalog is a plain Map and so is not
 * reactive; this is the one dependency the row builder needs to watch instead,
 * and bumping it per scope rather than per connection is what makes results
 * arrive progressively instead of all at the end of the slowest one.
 */
const cacheVersion = ref(0);

/**
 * What the palette reads out of the catalog. One cache, one version counter —
 * both module-level, so the dialog and the window shell always see one session.
 */
export interface TableCatalog {
	/** The single reactive dependency of the palette's row builder. */
	version: Ref<number>;
	loadTables(connectionId: string): Promise<void>;
	/**
	 * Walks one connection's discovered (database, schema) pairs. A visitor
	 * rather than a returned array: the row builder runs inside a computed, so a
	 * copy per connection per keystroke would be pure garbage.
	 */
	eachDiscoveredTable(
		connectionId: string,
		visit: (cached: CachedTables) => void,
	): void;
	reportFanOut(): void;
}

/**
 * Resolves `connections` per call — this module is imported before pinia is
 * installed — while the caches stay module-level, so every caller sees the same
 * discovery session no matter who asks.
 */
export function useTableCatalog(): TableCatalog {
	const connections = useConnectionsStore();

	/**
	 * Lists one (database, schema) into `catalog`, skipping a scope that has
	 * already answered. Resolves to an error message or null rather than
	 * rejecting: a schema the role cannot read is one hole in the catalog, not a
	 * reason to abandon the databases that did answer. Bumping `cacheVersion`
	 * here, per scope, is what makes results *progressive*.
	 */
	async function cacheScope(
		catalog: DiscoveredCatalog,
		connectionId: string,
		database: string,
		schema: string,
	): Promise<string | null> {
		const key = scopeKey(database, schema);
		// The retry path lands here: an incomplete catalog is re-walked so a
		// single unreadable schema is not re-queried on every keystroke.
		if (catalog.tables.has(key)) return null;
		try {
			const tables = await connections.listTables({
				connectionId,
				database,
				schema,
				filter: "",
			});
			catalog.tables.set(key, { database, schema, tables });
			cacheVersion.value += 1;
			return null;
		} catch (err) {
			return errorMessage(err);
		}
	}

	/**
	 * Walks one connection's whole chain — `listDatabases`, then per database
	 * either `listSchemas` and a list per schema (Postgres) or the database alone
	 * (MySQL, whose schema *is* the database) — writing each level in as it
	 * answers. Resolves to the first reason something failed, or null.
	 *
	 * Databases and schemas are chased concurrently, because the table being typed
	 * may live on any of them. On Postgres each database costs the one extra
	 * session the pool opens for it, which the sidebar then reuses.
	 */
	async function discover(
		config: ConnectionConfig,
		catalog: DiscoveredCatalog,
	): Promise<string | null> {
		const connectionId = config.id;
		let found: DatabaseInfo[] = [];
		try {
			// Asked of the *server*, not of a database, so the profile's own
			// (possibly empty) `database` field does not narrow the answer.
			found = await connections.listDatabases(connectionId);
		} catch (err) {
			return errorMessage(err);
		}
		catalog.databases = databasesToChase(config, found);

		const reasons = await Promise.all(
			catalog.databases.map(async (database) => {
				let schemas: string[];
				if (config.dbType === "postgres") {
					try {
						schemas = schemasToChase(
							config,
							await connections.listSchemas({ connectionId, database }),
						);
					} catch (err) {
						return errorMessage(err);
					}
					catalog.schemas.set(database, schemas);
				} else {
					schemas = [database];
				}
				const listed = await Promise.all(
					schemas.map((schema) =>
						cacheScope(catalog, connectionId, database, schema),
					),
				);
				return listed.find((reason) => reason !== null) ?? null;
			}),
		);
		// First failure, not all of them: they are near-certainly one cause, and
		// {@link reportFanOut} shows exactly one reason anyway.
		return reasons.find((reason) => reason !== null) ?? null;
	}

	/**
	 * Discovers one connection into its session catalog, opening a session for it
	 * first if it has none. Never rejects: a bad profile is skipped rather than
	 * allowed to empty the palette for the others. The reason is *recorded* rather
	 * than discarded, though — a silently empty palette is indistinguishable, to
	 * the user typing into it, from a table that does not exist.
	 *
	 * The connect is not bookkeeping: the backend answers only for a session
	 * `connect()` opened, so an unconnected profile's first list call throws.
	 */
	async function loadTables(connectionId: string): Promise<void> {
		const known = catalogs.get(connectionId);
		const fresh =
			known !== undefined && Date.now() - known.fetchedAt < CATALOG_TTL_MS;
		if (known?.complete && fresh) return;
		if (inFlight.has(connectionId)) return;
		const config = connections.configs.find((entry) => entry.id === connectionId);
		if (!config) return;

		// A half-answered record is re-walked and kept — `cacheScope` skips what
		// already landed. A stale one is replaced outright rather than merged,
		// because its *databases and schemas* may have changed too, and
		// answering from a stale enumeration is the guess this replaced.
		const catalog: DiscoveredCatalog =
			known && fresh
				? known
				: {
						fetchedAt: Date.now(),
						complete: false,
						databases: [],
						schemas: new Map<string, string[]>(),
						tables: new Map<string, CachedTables>(),
					};
		// Registered before the first query, so the scopes land in a record the
		// row builder can already see; a connection that dies before its first
		// answer is removed again below and leaves nothing behind.
		catalogs.set(connectionId, catalog);

		inFlight.add(connectionId);
		try {
			await connections.ensureConnected(connectionId);
			const failure = await discover(config, catalog);
			catalog.complete = failure === null;
			// The stamp moves on completion, complete or not, so a chain that took
			// a slow minute to answer still gets its full TTL of cheap searches
			// instead of expiring on the clock while it was being fetched.
			catalog.fetchedAt = Date.now();
			if (failure === null) {
				fetchErrors.delete(connectionId);
				// The palette works again, so a later outage is worth reporting.
				reportFanOutFired = false;
			} else {
				// Recorded, not thrown, and the record kept: what did answer stays
				// searchable while the reason explains the rest. An incomplete
				// catalog keeps `complete: false`, which re-walks it next search.
				fetchErrors.set(connectionId, failure);
			}
		} catch (err) {
			// Left uncached on purpose, so the next search retries it — the exact
			// "never connected" case a swallowed catch used to report as "no
			// tables". Kept as a reason because a profile fails here two distinct
			// ways: the session would not open, or it would open and not read.
			catalogs.delete(connectionId);
			fetchErrors.set(connectionId, errorMessage(err));
		} finally {
			inFlight.delete(connectionId);
			// Bumped for failures too: the map did not grow, but a row about to be
			// rendered must be re-evaluated against what it missed.
			cacheVersion.value += 1;
		}
	}

	/**
	 * Names a fan-out round that came back with *nothing* to show, and only then.
	 *
	 * The gate is the whole design. A fan-out touches every configured profile,
	 * so one unreachable server is the normal state of a laptop on a train, and a
	 * toast per failure is a storm across a keystroke burst. A failure is worth
	 * interrupting for only when it cost the feature entirely: every connection
	 * refused, nothing cached, no table query can answer this session.
	 */
	function reportFanOut(): void {
		// "Nothing to show" means no scope answered with *anything*, not merely
		// that no cache record exists: a connection whose schemas are all empty
		// was reached, and toasting "could not be reached" would be a lie about
		// a server that is working perfectly.
		if (reportFanOutFired || anyTablesCached() || fetchErrors.size === 0) return;
		reportFanOutFired = true;
		const failed = fetchErrors.size;
		const configs = connections.configs.length;
		// One reason, not `failed` of them: they are near-certainly all the same
		// cause, and a stacked list is unreadable in a 4s toast.
		const [first] = [...fetchErrors.values()];
		toast(
			failed === configs
				? `Quick Open cannot reach any connection: ${first}`
				: `Quick Open could not reach ${failed} of ${configs} connections: ${first}`,
		);
	}

	function eachDiscoveredTable(
		connectionId: string,
		visit: (cached: CachedTables) => void,
	): void {
		const catalog = catalogs.get(connectionId);
		if (!catalog) return;
		for (const cached of catalog.tables.values()) visit(cached);
	}

	return { version: cacheVersion, loadTables, eachDiscoveredTable, reportFanOut };
}