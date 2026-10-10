<script setup lang="ts">
import { computed, defineComponent, h, ref, watch } from "vue";
import type { Component } from "vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import { Columns3, Database, Folder, Key, Link, Pencil, RefreshCw, Search, Table2, Zap } from "lucide-vue-next";
import { useDebounceFn } from "@vueuse/core";
import DatabaseIcon from "../icons/DatabaseIcon.vue";
import DatabaseVisibilityDialog from "../dialogs/DatabaseVisibilityDialog.vue";
import TreeRow from "./TreeRow.vue";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import CustomContextMenu from "../ui/CustomContextMenu.vue";
import type { ContextMenuItem } from "../ui/CustomContextMenu.vue";
import { flattenTree } from "../../composables/useFlatTree";
import type { FlatTreeNode } from "../../composables/useFlatTree";
import { errorMessage } from "../../lib/rpc";
import { useToast } from "../../composables/useToast";
import { useConnectionsStore } from "../../stores/connections";
import type { ConnectionStatus } from "../../stores/connections";
import { useTabsStore } from "../../stores/tabs";
import type {
	ColumnInfo,
	ForeignKeyInfo,
	IndexInfo,
	TriggerInfo,
} from "../../../shared/types";
import type { DatabaseType } from "../../../shared/types";

/** Must match `RecycleScroller`'s `item-size` and the `.tree-row` height. */
const ROW_HEIGHT = 28;

/** Rows rendered outside the viewport to keep fast scrolling smooth. */
const ROW_BUFFER = 200;

/** A term containing this separator is read as `database.table`. */
const SEARCH_SEPARATOR = ".";

/**
 * How long the search box has to be still before its term is run. Long enough
 * that a typed word is one query rather than one per character, short enough
 * that the tree still answers while the word is being typed.
 */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * A connection is a *server*, not a database: it carries the host, port and
 * credentials, so every database on it is reachable from that one profile. The
 * levels below are `connection → database → schema → table` for Postgres, while
 * MySQL has no schema layer and its database rows list tables directly.
 * Postgres cannot cross databases in one session, so a database row is a
 * separate socket opened on demand. Below a table sits one `group` row per
 * metadata kind, fetched only when its group is opened; the `leaf` rows live
 * in `tableMeta` and are children only of the group that asked for them.
 */
type TreeNode =
	| {
			kind: "connection";
			key: string;
			id: string;
			label: string;
			status: ConnectionStatus;
			dbType: DatabaseType;
	  }
	| {
			kind: "database";
			key: string;
			connectionId: string;
			database: string;
			label: string;
	  }
	| {
			kind: "schema";
			key: string;
			connectionId: string;
			database: string;
			schema: string;
			/** What the row shows; the other fields are what the loaders use. */
			label: string;
	  }
	| {
			kind: "table";
			key: string;
			database: string;
			schema: string;
			table: string;
			connectionId: string;
	  }
	| {
			kind: "group";
			key: string;
			/** Which metadata list this row stands for. */
			group: MetaGroup;
			/** The owning table's key; every leaf below is namespaced by it. */
			tableKey: string;
			connectionId: string;
			database: string;
			schema: string;
			table: string;
	  }
	| {
			kind: "leaf";
			key: string;
			label: string;
			/** The trailing pill, e.g. `Not null` on a column. */
			badge?: LeafBadge;
			/** Row tooltip: a column comment, or a trigger body. */
			title?: string;
	  };

/** The four object kinds a table row breaks down into. */
type MetaGroup = "columns" | "indexes" | "foreignKeys" | "triggers";

/** The row standing for one of a table's four metadata lists. */
type GroupNode = Extract<TreeNode, { kind: "group" }>;

/** Tone of the trailing pill on a leaf; `warning` marks a constraint. */
interface LeafBadge {
	text: string;
	tone: "warning" | "muted";
}

/**
 * How each metadata group reads and what colour it wears, so the four rows
 * under a table are told apart without reading their labels.
 */
const META_GROUPS: Record<MetaGroup, { label: string; icon: Component; iconClass: string }> =
	{
		columns: { label: "Columns", icon: Columns3, iconClass: "text-green-500" },
		indexes: { label: "Indexes", icon: Key, iconClass: "text-yellow-500" },
		foreignKeys: { label: "Foreign Keys", icon: Link, iconClass: "text-blue-500" },
		triggers: { label: "Triggers", icon: Zap, iconClass: "text-orange-500" },
	};

/** The order the four groups appear under every table. */
const META_GROUP_ORDER: MetaGroup[] = ["columns", "indexes", "foreignKeys", "triggers"];

interface TreeRowBinding {
	label: string;
	depth: number;
	icon?: Component;
	hasChildren: boolean;
	expanded: boolean;
	selected: boolean;
	loading: boolean;
	iconClass: string;
	/** Weight class for the label, chosen from the node kind. */
	labelClass: string;
	childCount?: number;
	connected: boolean;
	connectedTitle?: string;
	/** Small pill after the label, e.g. a column's nullability. */
	badge?: { text: string; tone: "warning" | "muted" };
	/** Row tooltip, for details that do not fit in the label. */
	title?: string;
	contextable: boolean;
	onToggle: () => void;
	onActivate: () => void;
	/**
	 * Must be spelled exactly `onContextmenu`: Vue resolves an emit listener as
	 * `toHandlerKey(event)`, so a capital M misses and falls through to attrs,
	 * landing as a raw DOM listener that never fires.
	 */
	onContextmenu: (event: MouseEvent) => void;
}

const emit = defineEmits<{
	(e: "new-connection"): void;
	/** Id of the connection profile the user asked to edit. */
	(e: "edit-connection", connectionId: string): void;
}>();

/** The connection whose context menu is open; null while the menu is closed. */
const menuConnectionId = ref<string | null>(null);
/**
 * Items handed to the one shared `CustomContextMenu` host. Rebuilt on every
 * open so each item's disabled state is read at the moment of the right-click
 * rather than from an array built for an earlier row.
 */
const menuItems = ref<ContextMenuItem[]>([]);

/**
 * The profile whose databases are being shown or hidden, and whether that
 * dialog is open. Held beside the context menu rather than inside it because
 * the menu closes as the dialog opens.
 */
const visibilityId = ref<string | null>(null);
const visibilityOpen = ref(false);

/** The virtual scroller, for scrolling a row the user cannot currently see. */
const scroller = ref<{ scrollToItem: (index: number) => void } | null>(null);

const connections = useConnectionsStore();
const tabs = useTabsStore();
const { toast } = useToast();

const searchTerm = ref("");
const selectedKey = ref<string | null>(null);
const expanded = ref(new Set<string>());
/** Children per node key. A key present here is never refetched. */
const children = ref(new Map<string, TreeNode[]>());
/** Keys with an in-flight child fetch, used to spin their row. */
const loadingKeys = ref(new Set<string>());

/**
 * The promise each in-flight child fetch is published under, keyed like
 * `loadingKeys`. A caller that reaches a node another crawl already owns waits
 * on this instead of opening a second fetch for a key whose row is already
 * spinning. Waiting is not inheriting: the owner discards its result once it
 * has been superseded (see `claimCrawl`), so the waiter refetches under its
 * own ownership. Deliberately not a `ref` — nothing renders from it, and the
 * reactive proxy would only be paid for on every set and get.
 */
const inflight = new Map<string, Promise<void>>();
/**
 * Fetched metadata lists, keyed by table key and then by group. Kept apart
 * from `children` on purpose: `children` is what `flattenTree` walks, so a leaf
 * parked there would render at the wrong depth. This is also the memo that
 * makes a group cost at most one request however often it is expanded, and the
 * place a group row reads its count from once its list has been asked for.
 */
const tableMeta = ref(new Map<string, Map<MetaGroup, TreeNode[]>>());

/**
 * Group nodes whose fetch failed. They cache an empty list so their badge reads
 * 0 rather than disappearing, and are recorded here so opening one retries
 * instead of serving that empty list forever — a group the server refuses,
 * triggers under a locked-down role being the usual case.
 */
const failedGroups = ref(new Set<string>());

/**
 * Why a profile's subtree is missing, keyed by profile id. The status enum
 * cannot carry a reason, and it does not need one to describe the difference
 * that matters here: a server that answered and hosts nothing and a server
 * that never answered both leave the row with no children, so the enum's
 * `error` is the only signal distinguishing them, and it says nothing about
 * *which* server failed or why. Held per profile and cleared as soon as a
 * crawl rebuilds that subtree, so a reason cannot outlive the outage that
 * produced it.
 */
const connectionFailures = ref<Record<string, string>>({});

/**
 * Records why a profile's subtree could not be built. Replaces the entry
 * rather than merging, so a second failed crawl reports its own reason instead
 * of the first one's.
 */
function noteConnectionFailure(id: string, err: unknown): void {
	connectionFailures.value = { ...connectionFailures.value, [id]: errorMessage(err) };
}

/**
 * Drops a profile's recorded failure. Called where a crawl has just rebuilt
 * that subtree from a session that answered, which makes whatever was recorded
 * about it no longer true.
 */
function forgetConnectionFailure(id: string): void {
	if (!(id in connectionFailures.value)) return;
	const next = { ...connectionFailures.value };
	delete next[id];
	connectionFailures.value = next;
}

/** One letter per node kind, so a key names its kind without a full scan. */
const KEY_PREFIX: Record<TreeNode["kind"], string> = {
	connection: "c",
	database: "d",
	schema: "s",
	table: "t",
	group: "g",
	leaf: "l",
};

/**
 * Length-prefixes every part so the joined key cannot collide across nodes
 * whose names contain the separator (a schema literally named "a.b" would
 * otherwise share a key with schema "a" table "b").
 */
function makeKey(kind: TreeNode["kind"], ...parts: string[]): string {
	const body = parts.map((part) => `${part.length}:${part}`).join("");
	return `${KEY_PREFIX[kind]}|${body}`;
}

/** The table key a group's leaves are namespaced under. */
function tableKeyOf(
	connectionId: string,
	database: string,
	schema: string,
	table: string,
): string {
	return makeKey("table", connectionId, database, schema, table);
}

/** The already-fetched list for one group, or undefined while it is unknown. */
function metaLeaves(tableKey: string, group: MetaGroup): TreeNode[] | undefined {
	return tableMeta.value.get(tableKey)?.get(group);
}

function cacheMetaLeaves(tableKey: string, group: MetaGroup, nodes: TreeNode[]): void {
	let entry = tableMeta.value.get(tableKey);
	if (!entry) {
		entry = new Map<MetaGroup, TreeNode[]>();
		tableMeta.value.set(tableKey, entry);
	}
	entry.set(group, nodes);
}

const roots = computed<TreeNode[]>(() =>
	connections.configs.map((config) => ({
		kind: "connection",
		key: makeKey("connection", config.id),
		id: config.id,
		label: config.name,
		status: connections.status[config.id] ?? "disconnected",
		dbType: config.dbType,
	})),
);

/**
 * Splits the search box into the table-name filter handed to the backend. A
 * `database.table` term filters on the table name alone, so the match is found
 * in whichever container holds it: the part before the separator is a hint for
 * the reader, not a scope the server is ever asked to honour, and nothing is
 * left over for the tree to narrow its crawl by.
 */
function parseSearch(term: string): string {
	const trimmed = term.trim();
	const at = trimmed.indexOf(SEARCH_SEPARATOR);
	if (at <= 0) return trimmed;
	return trimmed.slice(at + 1).trim();
}

/** The term as the backend sees it: what every table list is fetched with. */
const searchFilter = computed(() => parseSearch(searchTerm.value));

/**
 * The databases on a server. Both dialects list them the same way, so this is
 * the only place the tree asks the server what it hosts; what happens below a
 * database is the driver's business.
 */
async function databaseNodes(connectionId: string): Promise<TreeNode[]> {
	const databases = await connections.listDatabases(connectionId);
	// The profile's own database is exempt here exactly as it is in the Quick
	// Open catalog: the dialog refuses to hide it, so only a hand-edited
	// profile reaches this line with it hidden, and a connection that expands
	// to nothing is indistinguishable from one that failed.
	const config = connections.configs.find((entry) => entry.id === connectionId);
	const hidden = new Set(
		(config?.hiddenDatabases ?? []).filter((name) => name !== config?.database),
	);
	return databases
		.filter((entry) => !hidden.has(entry.name))
		.map((entry) => ({
			kind: "database",
			key: makeKey("database", connectionId, entry.name),
			connectionId,
			database: entry.name,
			label: entry.name,
		}));
}

/**
 * The table rows of one schema.
 *
 * MySQL has no schema layer, so its database is passed as the schema too —
 * that is the qualification `mysqlDriver.listTables` writes.
 */
async function tableNodes(
	connectionId: string,
	database: string,
	schema: string,
): Promise<TreeNode[]> {
	const tables = await connections.listTables({
		connectionId,
		database,
		schema,
		filter: searchFilter.value,
	});
	return tables.map((entry) => ({
		kind: "table",
		key: tableKeyOf(connectionId, database, schema, entry.name),
		database,
		schema,
		table: entry.name,
		connectionId,
	}));
}

function childrenOf(node: TreeNode): TreeNode[] | undefined {
	return children.value.get(node.key);
}

function isExpanded(node: TreeNode): boolean {
	return expanded.value.has(node.key);
}

function isLoading(node: TreeNode): boolean {
	if (loadingKeys.value.has(node.key)) return true;
	return node.kind === "connection" && node.status === "connecting";
}

function setExpanded(key: string, open: boolean): void {
	if (open) expanded.value.add(key);
	else expanded.value.delete(key);
}

function setLoading(key: string, on: boolean): void {
	if (on) loadingKeys.value.add(key);
	else loadingKeys.value.delete(key);
}

function setChildren(key: string, nodes: TreeNode[]): void {
	children.value.set(key, nodes);
}

/** The four group rows a table expands into; building them touches no server. */
function groupNodes(
	tableKey: string,
	connectionId: string,
	database: string,
	schema: string,
	table: string,
): GroupNode[] {
	return META_GROUP_ORDER.map((group) => ({
		kind: "group",
		key: makeKey("group", tableKey, group),
		group,
		tableKey,
		connectionId,
		database,
		schema,
		table,
	}));
}

/**
 * Column rows, DBX-style: `public_id (char(12))` plus a nullability pill.
 *
 * Every column gets a tooltip, not only the commented ones. The label is
 * `name (type)` and the sidebar truncates it, so the two facts a user most
 * needs when the name is long — the full identifier and whether it is a key —
 * used to be unreachable: a column with no `comment` had no hover text at all.
 * The facts are joined with `·` rather than newlines because `TooltipContent`
 * is an inline-flex with no `whitespace-pre-wrap` and wraps inside `max-w-lg`.
 */
function columnLeaves(tableKey: string, columns: ColumnInfo[]): TreeNode[] {
	return columns.map((column) => ({
		kind: "leaf",
		key: makeKey("leaf", tableKey, "columns", column.name),
		label: `${column.name} (${column.dataType})`,
		badge: column.isNullable
			? { text: "Nullable", tone: "muted" }
			: { text: "Not null", tone: "warning" },
		title: [
			`${column.name} (${column.dataType})`,
			column.isNullable ? "NULL" : "NOT NULL",
			column.isPrimaryKey ? "PRIMARY KEY" : undefined,
			column.defaultValue === null
				? undefined
				: `DEFAULT ${column.defaultValue}`,
			column.comment ?? undefined,
		]
			.filter((part) => part !== undefined)
			.join(" · "),
	}));
}

/**
 * Index rows, listing the key columns in index order: `idx (a, b)`.
 *
 * As with columns, the title is unconditional: uniqueness and the index method
 * are not on the label, and a composite index's key list is exactly what gets
 * truncated away in a narrow sidebar.
 */
function indexLeaves(tableKey: string, indexes: IndexInfo[]): TreeNode[] {
	return indexes.map((index) => ({
		kind: "leaf",
		key: makeKey("leaf", tableKey, "indexes", index.name),
		label: `${index.name} (${index.columns.join(", ")})`,
		title: [
			`${index.name} (${index.columns.join(", ")})`,
			index.isPrimary ? "PRIMARY KEY" : index.isUnique ? "UNIQUE" : undefined,
			index.method ?? undefined,
		]
			.filter((part) => part !== undefined)
			.join(" · "),
	}));
}

/** Foreign-key rows, pointing at the table they reference. */
function foreignKeyLeaves(tableKey: string, foreignKeys: ForeignKeyInfo[]): TreeNode[] {
	return foreignKeys.map((foreignKey) => ({
		kind: "leaf",
		key: makeKey("leaf", tableKey, "foreignKeys", foreignKey.name),
		label: `${foreignKey.name} → ${foreignKey.referencedTable} (${foreignKey.columns.join(", ")})`,
	}));
}

/**
 * Trigger rows. MySQL reports no timing and some servers report no event, so
 * the parenthetical is whatever parts actually exist; the body is the tooltip.
 */
function triggerLeaves(tableKey: string, triggers: TriggerInfo[]): TreeNode[] {
	return triggers.map((trigger) => ({
		kind: "leaf",
		key: makeKey("leaf", tableKey, "triggers", trigger.name),
		label: `${trigger.name} (${[trigger.timing, trigger.event].filter(Boolean).join(" ")})`,
		title: trigger.statement || undefined,
	}));
}

/**
 * One request for one group, fired only when the user opens that group. The
 * four lists stay separate requests, so a server that refuses triggers cannot
 * withhold the columns.
 */
async function fetchMetaLeaves(node: GroupNode): Promise<TreeNode[]> {
	const params = {
		connectionId: node.connectionId,
		database: node.database,
		schema: node.schema,
		table: node.table,
	};
	if (node.group === "columns") {
		return columnLeaves(node.tableKey, await connections.listColumns(params));
	}
	if (node.group === "indexes") {
		return indexLeaves(node.tableKey, await connections.listIndexes(params));
	}
	if (node.group === "foreignKeys") {
		return foreignKeyLeaves(node.tableKey, await connections.listForeignKeys(params));
	}
	return triggerLeaves(node.tableKey, await connections.listTriggers(params));
}

/**
 * Who owns the tree. Bumped by every crawl that starts and by every keystroke,
 * so "is my crawl still current?" is one comparison, not a race on promises.
 *
 * A crawl is not atomic: it fetches one node at a time and writes each as it
 * lands. Overlapping crawls meant the newer dropped the lists the older was
 * building and the older wrote underneath the drop — and `flattenTree` emits a
 * child only when its parent is expanded *and* present, so those rows landed
 * nowhere: an empty tree, no error, search apparently broken.
 */
let crawlGeneration = 0;

/**
 * Claims the tree for one crawl and hands back the check that crawl carries for
 * its whole run. `true` means a newer crawl — or a newer keystroke — has taken
 * over, and the holder must return at its next await boundary without writing.
 */
function claimCrawl(): () => boolean {
	const mine = ++crawlGeneration;
	return () => crawlGeneration !== mine;
}

/**
 * Loads a node's children once, but only for the caller that still owns the
 * tree. `superseded` is checked before the fetch and after every await inside
 * it, so a replaced crawl writes nothing — it fetched with a term the user has
 * typed past, into a tree emptied in the meantime.
 *
 * A node another crawl owns is waited for, then refetched rather than skipped:
 * skipping is what left a search showing nothing, since the newest crawl walked
 * past every node the oldest still owned.
 */
async function loadChildren(node: TreeNode, superseded?: () => boolean): Promise<void> {
	if (node.kind === "leaf") return;
	if (children.value.has(node.key)) return;
	if (superseded?.()) return;
	while (true) {
		const pending = inflight.get(node.key);
		if (!pending) break;
		await pending;
		// The owner may have written after all — this caller only got here
		// because that write had not landed yet — and a caller that has itself
		// been replaced has no business refetching anything.
		if (children.value.has(node.key) || superseded?.()) return;
	}

	setLoading(node.key, true);
	// Published before the first await so a caller arriving mid-fetch waits on
	// the promise rather than starting a duplicate for the same node.
	const request = fetchChildren(node, superseded);
	inflight.set(node.key, request);
	try {
		await request;
	} finally {
		inflight.delete(node.key);
		setLoading(node.key, false);
	}
}

/**
 * The fetch-and-write half of `loadChildren`, split out so a run can be
 * published to a waiting caller before its first await. Every fetch lands in a
 * local first: the ownership check has to sit between the await and the write,
 * which it cannot do from inside a call argument — `setChildren(key, await …)`
 * stores a stale list the instant the newer crawl has emptied that container.
 */
async function fetchChildren(node: TreeNode, superseded?: () => boolean): Promise<void> {
	try {
		if (node.kind === "connection") {
			// A search asks every saved profile to open a session at once, so a
			// failure here is one row out of many rather than the user's single
			// intent — and a toast per unreachable server is a wall of
			// near-identical notifications with the profile the user actually
			// cares about buried in the middle. The failure is recorded on the
			// row instead, which is strictly more legible than a toast anyway:
			// it stays readable after the crawl moves on, and it is attached to
			// the one server it belongs to. `connections.connect` has already
			// set the status to `error`, so the row's glyph carries it too.
			try {
				await connections.ensureConnected(node.id);
			} catch (err) {
				noteConnectionFailure(node.id, err);
				return;
			}
			// A session that answered makes any previously recorded reason stale,
			// and the connection is about to be rewritten from it.
			forgetConnectionFailure(node.id);
			const databases = await databaseNodes(node.id);
			if (superseded?.()) return;
			setChildren(node.key, databases);
		} else if (node.kind === "database") {
			// Postgres nests schemas inside the database; MySQL has no such
			// layer, so its database opens straight onto its tables.
			const config = connections.configs.find(
				(entry) => entry.id === node.connectionId,
			);
			if (config?.dbType === "mysql") {
				const tables = await tableNodes(
					node.connectionId,
					node.database,
					node.database,
				);
				if (superseded?.()) return;
				setChildren(node.key, tables);
			} else {
				const schemas = await connections.listSchemas({
					connectionId: node.connectionId,
					database: node.database,
				});
				if (superseded?.()) return;
				setChildren(
					node.key,
					schemas.map((name) => ({
						kind: "schema",
						key: makeKey("schema", node.connectionId, node.database, name),
						connectionId: node.connectionId,
						database: node.database,
						schema: name,
						label: name,
					})),
				);
			}
		} else if (node.kind === "schema") {
			const tables = await tableNodes(node.connectionId, node.database, node.schema);
			if (superseded?.()) return;
			setChildren(node.key, tables);
		} else if (node.kind === "table") {
			// A table row is only a container. Its four groups are cheap to build
			// and cost one request each to fill, so opening a table must fire
			// none of them — the user opened it to see its name, and only the
			// group they then expand is a question worth asking the server.
			setChildren(
				node.key,
				groupNodes(node.key, node.connectionId, node.database, node.schema, node.table),
			);
		} else if (node.kind === "group") {
			// Spelled out rather than a bare `else`: `loadChildren` returns on a
			// leaf before ever calling this, but that exclusion does not survive
			// the hop into a separate function, so the last branch would
			// otherwise be typed as "group or leaf" and reach for a leaf's
			// missing `tableKey`/`group`.
			// The memo is what makes this the single fetch path: an already-loaded
			// group costs nothing to reopen, and only a group whose fetch failed
			// (or whose cache was dropped) asks the server again.
			const cached = failedGroups.value.has(node.key)
				? undefined
				: metaLeaves(node.tableKey, node.group);
			if (cached) {
				setChildren(node.key, cached);
				return;
			}
			try {
				const leaves = await fetchMetaLeaves(node);
				// Nothing is cached on the way out of a superseded run either:
				// the memo promises "this group's leaves", not "leaves fetched by
				// a crawl that was told to stop".
				if (superseded?.()) return;
				cacheMetaLeaves(node.tableKey, node.group, leaves);
				failedGroups.value.delete(node.key);
				setChildren(node.key, leaves);
			} catch {
				// A refused list is not worth a toast of its own — the group reads
				// as empty, and marking it is what lets the next expand retry rather
				// than serve that emptiness forever. Nothing is written to
				// `children`, since that map is what `loadChildren` reads as
				// "already loaded" and would block the retry; the cached empty list
				// is what the row's count falls back to.
				cacheMetaLeaves(node.tableKey, node.group, []);
				failedGroups.value.add(node.key);
			}
		}
	} catch (err) {
		toast(errorMessage(err));
	}
}

function toggle(node: TreeNode): void {
	if (node.kind === "leaf") return;
	const open = !isExpanded(node);
	setExpanded(node.key, open);
	if (open) void loadChildren(node);
}

function activate(node: TreeNode): void {
	if (node.kind === "leaf") return;
	if (node.kind === "table") {
		selectedKey.value = node.key;
		const tab = tabs.openTableTab({
			connectionId: node.connectionId,
			database: node.database,
			schema: node.schema,
			table: node.table,
		});
		tabs.activate(tab.id);
		void connections
			.ensureConnected(node.connectionId)
			.catch((err) => toast(errorMessage(err)));
		return;
	}
	// A group row carries no action of its own; clicking it just opens it.
	toggle(node);
}

/**
 * Opens every connection, database and schema so a table-name filter has
 * somewhere to match, sequenced because a server takes only so much at once,
 * with `superseded` re-read at every level so a newer term leaves the rest
 * alone. Expansion is not optional — that is what separates this from
 * `reloadOpenContainers`: a match inside a collapsed container is a row the
 * user cannot see. It stops at the schemas because expanding a table fans out
 * into four metadata requests a keystroke must not trigger everywhere.
 */
async function expandAll(superseded: () => boolean): Promise<void> {
	for (const connection of roots.value) {
		if (superseded()) return;
		setExpanded(connection.key, true);
		await loadChildren(connection, superseded);
		if (superseded()) return;
		for (const database of childrenOf(connection) ?? []) {
			if (database.kind !== "database") continue;
			setExpanded(database.key, true);
			await loadChildren(database, superseded);
			if (superseded()) return;
			for (const schema of childrenOf(database) ?? []) {
				if (schema.kind !== "schema") continue;
				setExpanded(schema.key, true);
				await loadChildren(schema, superseded);
				if (superseded()) return;
			}
		}
	}
}

/**
 * A filter change invalidates every table list, since each was fetched with the
 * previous filter. Dropping the cache is what makes the next expansion refetch;
 * a node the user never opened keeps its absence and stays offline.
 *
 * The drop cascades — groups lose their leaves, the fetched metadata goes too —
 * because holding every list the user drilled into would grow without bound.
 * Failure marks go too, so a stale empty list cannot suppress its retry.
 */
function dropTableLists(): void {
	const stale = [
		`${KEY_PREFIX.database}|`,
		`${KEY_PREFIX.schema}|`,
		`${KEY_PREFIX.table}|`,
		`${KEY_PREFIX.group}|`,
	];
	for (const key of children.value.keys()) {
		if (stale.some((prefix) => key.startsWith(prefix))) children.value.delete(key);
	}
	// A group whose leaves were just dropped would otherwise render as expanded
	// and empty; closing it also means the next expand refetches them.
	for (const key of expanded.value) {
		if (key.startsWith(`${KEY_PREFIX.group}|`)) expanded.value.delete(key);
	}
	tableMeta.value.clear();
	failedGroups.value.clear();
}

/**
 * Drops the cached lists of one connection only, because the session they came
 * from has just been replaced — a global drop would cost the user their whole
 * tree on every reconnect.
 *
 * Keys are length-prefixed and carry no connection id in a readable position,
 * so the subtree is walked instead: children are dropped only after their
 * descendants have been collected. Expansion survives — the user opened those
 * nodes and meant to — so the connection is refetched at the depth it was left.
 */
function dropConnectionLists(connectionId: string): void {
	const connection = roots.value.find(
		(node): node is Extract<TreeNode, { kind: "connection" }> =>
			node.kind === "connection" && node.id === connectionId,
	);
	if (!connection) return;

	const stale: string[] = [];
	const walk = (node: TreeNode): void => {
		stale.push(node.key);
		for (const child of childrenOf(node) ?? []) walk(child);
	};
	walk(connection);

	for (const key of stale) {
		children.value.delete(key);
		tableMeta.value.delete(key);
		failedGroups.value.delete(key);
		// A group whose leaves were just dropped would render as expanded and
		// empty; closing it is also what lets the next expand refetch them.
		if (key.startsWith(`${KEY_PREFIX.group}|`)) expanded.value.delete(key);
	}
}

/**
 * Replaces a connection's session and re-reads what the user has open.
 *
 * The cache drop and the refetch are the point of the action: without them the
 * tree would keep showing database and table lists produced by a socket the
 * backend has already dropped, which look valid right up until they are used.
 */
async function reconnectConnection(): Promise<void> {
	const id = menuConnectionId.value;
	if (!id) return;
	try {
		await connections.reconnect(id);
	} catch (err) {
		toast(errorMessage(err));
		return;
	}
	dropConnectionLists(id);
	// The refetch rebuilds this subtree from the new session, so it claims the
	// tree before running: a search still crawling over the socket that was just
	// replaced must not write lists derived from it.
	const superseded = claimCrawl();
	try {
		await reloadOpenContainers(superseded);
	} catch (err) {
		toast(errorMessage(err));
	}
}

/**
 * Refetches every container node currently open, after a cache drop. Expansion
 * is the filter: only nodes the user opened are worth asking again, because
 * those are the ones a drop took from. A search cannot work this way — its
 * matches hide in containers the user never opened — which is why it crawls with
 * `expandAll` instead of reusing this.
 *
 * The ownership check is passed in, not claimed: the caller owns this run, and
 * claiming again would make every node it waits on declare it stale.
 */
async function reloadOpenContainers(superseded: () => boolean): Promise<void> {
	for (const connection of roots.value) {
		if (!isExpanded(connection)) continue;
		await loadChildren(connection, superseded);
		if (superseded()) return;
		for (const database of childrenOf(connection) ?? []) {
			if (database.kind !== "database" || !isExpanded(database)) continue;
			await loadChildren(database, superseded);
			if (superseded()) return;
			for (const schema of childrenOf(database) ?? []) {
				if (schema.kind !== "schema" || !isExpanded(schema)) continue;
				await loadChildren(schema, superseded);
				if (superseded()) return;
			}
		}
	}
}

/**
 * The debounced entry point. `useDebounceFn` rather than a hand-rolled timer,
 * because the goal is not debouncing itself: one settled term is one crawl of
 * every connection on the server, and the terms between a word's first and last
 * character can only ever produce rows the next keystroke discards.
 */
const runSearch = useDebounceFn(onSearchChanged, SEARCH_DEBOUNCE_MS);

/**
 * The generation is bumped here rather than inside the debounced body. A crawl
 * already running is fetching for the term this keystroke replaces, and it has
 * to stop writing the moment the user types — not when the debounce expires.
 */
watch(
	() => searchFilter.value,
	(next, previous) => {
		if (next === previous) return;
		crawlGeneration++;
		void runSearch(next);
	},
);

/**
 * One settled term, one crawl. The cache drop rides in here so it happens once
 * per term rather than once per character: every list still in the tree was
 * fetched with the previous filter, so it has to go before the refetch and
 * never after it.
 */
async function onSearchChanged(filter: string): Promise<void> {
	const superseded = claimCrawl();
	dropTableLists();
	try {
		if (filter === "") {
			// Clearing the box restores the unfiltered lists of open containers.
			await reloadOpenContainers(superseded);
			return;
		}
		// A `database.table` term is matched on its table name alone, so it is
		// searched exactly as a bare name is — same crawl, same expansion. The
		// shortcut it used to take through `reloadOpenContainers` opened nothing
		// the user had not already opened, so on a collapsed tree it fetched
		// matches and showed none.
		await expandAll(superseded);
	} catch (err) {
		toast(errorMessage(err));
	}
}

const rows = computed<FlatTreeNode<TreeNode>[]>(() =>
	flattenTree(roots.value, expanded.value, childrenOf, (node) => node.key),
);

/**
 * The glyph a row wears. Colour is what makes a long table list skimmable, so
 * each kind keeps the hue DBX gives it: amber for containers, green for tables,
 * and one hue per metadata group. Leaves carry none — their label says it all.
 */
function rowGlyph(node: TreeNode): { icon?: Component; iconClass: string } {
	// A brand mark carries its own colour, so the connection row wears no tint
	// — tinting a logo only muddies it. The status dot beside the label is what
	// still says whether that session is live.
	if (node.kind === "connection") {
		return { icon: databaseIconFor(node.dbType), iconClass: "" };
	}
	if (node.kind === "database") return { icon: Database, iconClass: "text-yellow-500" };
	if (node.kind === "schema") {
		return { icon: Folder, iconClass: "text-yellow-500" };
	}
	if (node.kind === "table") return { icon: Table2, iconClass: "text-green-500" };
	if (node.kind === "group") {
		const group = META_GROUPS[node.group];
		return { icon: group.icon, iconClass: group.iconClass };
	}
	return { iconClass: "text-muted-foreground" };
}

/**
 * A vendor mark per dialect, built once. The rows render icons through
 * `<component :is>` with no props of their own, so each mark is wrapped to
 * carry its dialect — `DatabaseIcon` cannot be told which one it is from the
 * caller.
 */
const DATABASE_ICONS: Record<DatabaseType, Component> = {
	postgres: defineComponent(() => () => h(DatabaseIcon, { dbType: "postgres" })),
	mysql: defineComponent(() => () => h(DatabaseIcon, { dbType: "mysql" })),
};

function databaseIconFor(dbType: DatabaseType): Component {
	return DATABASE_ICONS[dbType] ?? DATABASE_ICONS.postgres;
}

/**
 * The count trailing a row's label. A group's is known only once it has been
 * fetched, so it appears from that first expand onwards and stays while the
 * group is collapsed again. Every other row waits for its own expand, since a
 * zero for a node nobody has asked about would be a lie.
 */
function childCountOf(node: TreeNode): number | undefined {
	if (node.kind === "group") return metaLeaves(node.tableKey, node.group)?.length;
	if (!isExpanded(node)) return undefined;
	// A MySQL database holds tables directly; a Postgres one holds schemas, so
	// counting its tables would report zero for a database full of them.
	if (node.kind === "database" || node.kind === "schema") {
		return (childrenOf(node) ?? []).filter(
			(child) => child.kind === "schema" || child.kind === "table",
		).length;
	}
	return undefined;
}

/**
 * Row props for one scroller slot. Typed on the slot payload rather than the
 * slot itself so the binding stays fully checked at the `v-bind` site.
 */
function rowBinding(
	slot: unknown,
	openMenu: (event: MouseEvent, items?: ContextMenuItem[]) => void,
): TreeRowBinding {
	const { item } = slot as { item: FlatTreeNode<TreeNode> };
	const node = item.node;
	const leaf = node.kind === "leaf" ? node : undefined;
	return {
		// The container node carries the label its own driver filters on, so the
		// row never names a level that was not the one queried.
		label:
			node.kind === "table"
				? node.table
				: node.kind === "group"
					? META_GROUPS[node.group].label
					: node.label,
		depth: item.depth,
		...rowGlyph(node),
		// DBX weights the connection row above its objects (480 vs 430 on the
		// Geist axis); every other kind is an object here.
		labelClass:
			node.kind === "connection" ? "tree-label-connection" : "tree-label-object",
		// Everything but a leaf expands; a group row opens its list and nothing
		// else, and the twisty is what invites that click.
		hasChildren: node.kind !== "leaf",
		expanded: isExpanded(node),
		selected: selectedKey.value === node.key,
		loading: isLoading(node),
		childCount: childCountOf(node),
		badge: leaf?.badge,
		// A connection that could not be reached reads as an empty row, which is
		// indistinguishable from a server that answered and holds nothing. The
		// recorded reason rides the row's tooltip, which is already the place
		// detail that does not fit in a label goes — and `TreeRow` renders it
		// through the shared Tooltip, so the reason wraps instead of clipping.
		title:
			node.kind === "connection"
				? connectionFailures.value[node.id]
				: leaf?.title,
		connected:
			node.kind === "connection" &&
			connections.status[node.id] === "connected",
		// The status map is keyed by connection id, which only exists on a
		// connection node, so a lookup on any other kind is guarded above.
		connectedTitle:
			node.kind === "connection" ? connections.status[node.id] : undefined,
		// Only a connection owns an action of its own, so only it answers a
		// right-click; every other row keeps the browser's native menu.
		contextable: node.kind === "connection",
		onToggle: () => toggle(node),
		onActivate: () => activate(node),
		onContextmenu: (event: MouseEvent) => onRowContextMenu(node, event, openMenu),
	};
}

function onRowContextMenu(
	node: TreeNode,
	event: MouseEvent,
	openMenu: (event: MouseEvent, items?: ContextMenuItem[]) => void,
): void {
	if (node.kind !== "connection") return;
	menuConnectionId.value = node.id;
	menuItems.value = connectionMenuItems();
	// The just-built array rides the open call as an override: the prop update
	// and the open land in the same event turn, so reading `menuItems` back
	// after the flush would race the very state this handler just set.
	openMenu(event, menuItems.value);
}

/**
 * The actions a connection row offers. Reconnect leads because it is what a
 * broken session wants; Edit and the visibility dialog configure the session
 * and the tree respectively, so they follow.
 */
function connectionMenuItems(): ContextMenuItem[] {
	const id = menuConnectionId.value;
	return [
		{
			label: "Reconnect",
			icon: RefreshCw,
			disabled: !id || connections.status[id] === "connecting",
			action: reconnectConnection,
		},
		{
			label: "Edit connection",
			icon: Pencil,
			disabled: !id,
			action: editConnection,
		},
		{
			label: "Databases…",
			icon: Database,
			disabled: !id,
			action: manageDatabases,
		},
	];
}

function editConnection(): void {
	if (!menuConnectionId.value) return;
	emit("edit-connection", menuConnectionId.value);
}

/** Opens the show/hide dialog for the row the context menu was opened on. */
function manageDatabases(): void {
	if (!menuConnectionId.value) return;
	visibilityId.value = menuConnectionId.value;
	visibilityOpen.value = true;
}

/**
 * Rebuilds one connection's rows after the dialog wrote a new hidden list.
 *
 * The subtree cache is dropped rather than filtered: what a database that is
 * being hidden had underneath it — schemas, tables, their loaded metadata — is
 * exactly what must not survive being shown again, since the fetch happened
 * under a different hidden list. What replaces it depends on what the tree is
 * showing: a search re-crawls, an unfiltered tree refetches only the containers
 * that were dropped *and* are still open, because `loadChildren` skips every
 * node the drop did not touch.
 */
async function onDatabasesChanged(connectionId: string): Promise<void> {
	dropConnectionLists(connectionId);
	// With a term typed the tree *is* a search result, and only a fresh crawl
	// rebuilds it consistently: a filter crawl opens containers as it goes, so
	// refetching just the ones already open would leave the rest of the tree
	// short of matches. This is what the watcher does for a new term, with the
	// same term.
	if (searchFilter.value !== "") {
		crawlGeneration++;
		await runSearch(searchFilter.value);
		return;
	}
	const superseded = claimCrawl();
	try {
		await reloadOpenContainers(superseded);
	} catch (err) {
		toast(errorMessage(err));
	}
}

/**
 * Reveals whatever the active tab points at: opens its ancestors, selects the
 * row and scrolls it into view, so the sidebar says where the work came from.
 *
 * Each ancestor is loaded as it is opened, because `flattenTree` only emits a
 * child whose key is in `expanded` *and* whose parent has cached children — so
 * this costs the queries clicking down by hand would. The target is resolved
 * after each load, which is why a tab whose connection was deleted does nothing.
 */
async function locateActiveTab(): Promise<void> {
	const tab = tabs.activeTab;
	if (!tab) return;

	// Locating a tab is a crawl like any other: it walks containers and writes
	// as it goes, so it claims the tree and stops if a search overtakes it.
	const superseded = claimCrawl();

	const connection = roots.value.find(
		(node): node is Extract<TreeNode, { kind: "connection" }> =>
			node.kind === "connection" && node.id === tab.connectionId,
	);
	if (!connection) return;

	setExpanded(connection.key, true);
	await loadChildren(connection, superseded);
	if (superseded()) return;

	// The tab names both a database and a schema; the tree's rows carry them as
	// fields, which is what identifies a row without relying on its key. MySQL
	// has no schema row, so its database is the deepest container and holds the
	// table itself.
	const database = (childrenOf(connection) ?? []).find(
		(node): node is Extract<TreeNode, { kind: "database" }> =>
			node.kind === "database" && node.database === tab.database,
	);
	if (!database) return;

	setExpanded(database.key, true);
	await loadChildren(database, superseded);
	if (superseded()) return;

	const schema = (childrenOf(database) ?? []).find(
		(node): node is Extract<TreeNode, { kind: "schema" }> =>
			node.kind === "schema" && node.schema === tab.schema,
	);
	const container = schema ?? database;

	if (schema) {
		setExpanded(schema.key, true);
		await loadChildren(schema, superseded);
		if (superseded()) return;
	}

	// A query tab names no table, so the deepest row it can resolve to is its
	// container; a table the active filter is hiding falls back to it as well,
	// rather than selecting nothing.
	let target: TreeNode = container;
	if (tab.mode === "table" && tab.table) {
		const tableKey = tableKeyOf(tab.connectionId, tab.database, tab.schema, tab.table);
		const table = (childrenOf(container) ?? []).find(
			(node): node is Extract<TreeNode, { kind: "table" }> =>
				node.kind === "table" && node.key === tableKey,
		);
		if (table) {
			target = table;
			setExpanded(table.key, true);
			await loadChildren(table, superseded);
			if (superseded()) return;
		}
	}

	selectedKey.value = target.key;

	// The index has to be read from the flattened list, since that — not the raw
	// tree — is what the scroller holds.
	const index = rows.value.findIndex((row) => row.node.key === target.key);
	if (index >= 0) scroller.value?.scrollToItem(index);
}

function collapseAll(): void {
	expanded.value.clear();
}

defineExpose({ collapseAll, locateActiveTab });
</script>

<template>
	<div class="flex min-h-0 flex-1 flex-col">
		<!-- Outside the scroller, so it stays put while the rows scroll under it. -->
		<div class="flex shrink-0 items-center gap-1 px-2 py-1">
			<div class="relative min-w-0 flex-1">
				<Search
					class="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<Input
					v-model="searchTerm"
					class="h-6 pl-7 text-xs"
					placeholder="Search tables"
					aria-label="Search tables"
					spellcheck="false"
				/>
			</div>
		</div>

		<div
			v-if="!connections.hydrated"
			class="flex min-h-0 flex-1 items-center justify-center px-4 text-center"
		>
			<p class="text-xs text-muted-foreground">Loading connections…</p>
		</div>

		<div
			v-else-if="roots.length === 0"
			class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center"
		>
			<p class="text-xs text-muted-foreground">No connections yet</p>
			<Button size="sm" @click="emit('new-connection')">New connection</Button>
		</div>

		<!-- One menu for every row. Rows are virtualised, so a per-row menu
		     would remount with every scroll; this single host is asked to open
		     at the pointer by whichever row was right-clicked. -->
		<CustomContextMenu v-else :items="menuItems" v-slot="contextMenuSlot">
			<RecycleScroller
				ref="scroller"
				class="recall-scroll min-h-0 flex-1"
				:items="rows"
				:item-size="ROW_HEIGHT"
				:buffer="ROW_BUFFER"
				key-field="key"
				role="tree"
				aria-label="Connections"
			>
				<template #default="slot">
					<TreeRow v-bind="rowBinding(slot, contextMenuSlot.onContextMenu)" />
				</template>
			</RecycleScroller>
		</CustomContextMenu>

		<DatabaseVisibilityDialog
			v-model:open="visibilityOpen"
			:connection-id="visibilityId"
			@changed="onDatabasesChanged"
		/>
	</div>
</template>