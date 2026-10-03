<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Component } from "vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import { Columns3, Database, Key, Link, Pencil, Search, Server, Table2, Zap } from "lucide-vue-next";
import TreeRow from "./TreeRow.vue";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
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

/** Must match `RecycleScroller`'s `item-size` and the `.tree-row` height. */
const ROW_HEIGHT = 28;

/** Rows rendered outside the viewport to keep fast scrolling smooth. */
const ROW_BUFFER = 200;

/** A term containing this separator is read as `database.table`. */
const SEARCH_SEPARATOR = ".";

/**
 * The second level is the container the table list is actually queried against,
 * which is not always the database: Postgres filters on the schema, so
 * `connection → schema → table` is the honest shape, while MySQL has no schema
 * layer and filters on the database itself.
 * Below a table the tree carries read-only metadata: one `group` row per kind
 * of object. Opening the table only builds those four rows; each list is
 * fetched when its group is opened, so expanding a table a user is merely
 * browsing costs nothing. The `leaf` rows a list describes are never loaded
 * into the tree the loaders walk — they live in `tableMeta` and are
 * materialised as children only for the group that asked for them.
 */
type TreeNode =
	| {
			kind: "connection";
			key: string;
			id: string;
			label: string;
			status: ConnectionStatus;
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
const menuOpen = ref(false);
/**
 * Virtual anchor for the context menu. `DropdownMenu` positions its content
 * against the trigger element, so a zero-size element parked at the pointer is
 * what puts the menu under the cursor rather than under the whole tree. The
 * menu is opened by the right-click handler, never by clicking this.
 */
const menuAnchor = ref({ x: 0, y: 0 });

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

/** One letter per node kind, so a key names its kind without a full scan. */
const KEY_PREFIX: Record<TreeNode["kind"], string> = {
	connection: "c",
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
	})),
);

/**
 * Splits the search box into the table-name filter handed to the backend. A
 * `database.table` term filters on the table name alone, so the match is found
 * in whichever container holds it.
 */
function parseSearch(term: string): { filter: string; scoped: boolean } {
	const trimmed = term.trim();
	const at = trimmed.indexOf(SEARCH_SEPARATOR);
	if (at <= 0) return { filter: trimmed, scoped: false };
	return { filter: trimmed.slice(at + 1).trim(), scoped: true };
}

const search = computed(() => parseSearch(searchTerm.value));

/**
 * The single container level under a connection, in the shape the table list
 * is actually queried in. Postgres filters on `defaultSchema`, so the one
 * visible node is that schema; MySQL filters on the database, so each database
 * is its own node.
 */
async function containerNodes(connectionId: string): Promise<TreeNode[]> {
	const config = connections.configs.find((entry) => entry.id === connectionId);
	if (!config) return [];
	if (config.dbType === "mysql") {
		const databases = await connections.listDatabases(connectionId);
		return databases.map((entry) => ({
			kind: "schema",
			key: makeKey("schema", connectionId, entry.name),
			connectionId,
			database: entry.name,
			schema: entry.name,
			label: entry.name,
		}));
	}
	return [
		{
			kind: "schema",
			key: makeKey("schema", connectionId, config.defaultSchema),
			connectionId,
			database: config.database,
			schema: config.defaultSchema,
			label: config.defaultSchema,
		},
	];
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

/** Column rows, DBX-style: `public_id (char(12))` plus a nullability pill. */
function columnLeaves(tableKey: string, columns: ColumnInfo[]): TreeNode[] {
	return columns.map((column) => ({
		kind: "leaf",
		key: makeKey("leaf", tableKey, "columns", column.name),
		label: `${column.name} (${column.dataType})`,
		badge: column.isNullable
			? { text: "Nullable", tone: "muted" }
			: { text: "Not null", tone: "warning" },
		title: column.comment ?? undefined,
	}));
}

/** Index rows, listing the key columns in index order: `idx (a, b)`. */
function indexLeaves(tableKey: string, indexes: IndexInfo[]): TreeNode[] {
	return indexes.map((index) => ({
		kind: "leaf",
		key: makeKey("leaf", tableKey, "indexes", index.name),
		label: `${index.name} (${index.columns.join(", ")})`,
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
 * Loads a node's children once. A cached or in-flight node returns without
 * touching the network, so re-expanding a subtree costs nothing. Connection
 * and schema failures are toasted and left uncached, so the next expand
 * retries; a group that fails is handled inside its branch instead, because
 * it has to stay visibly empty rather than throw away the whole subtree.
 */
async function loadChildren(node: TreeNode): Promise<void> {
	if (node.kind === "leaf") return;
	if (children.value.has(node.key) || loadingKeys.value.has(node.key)) return;

	setLoading(node.key, true);
	try {
		if (node.kind === "connection") {
			await connections.ensureConnected(node.id);
			setChildren(node.key, await containerNodes(node.id));
		} else if (node.kind === "schema") {
			const tables = await connections.listTables({
				connectionId: node.connectionId,
				database: node.database,
				schema: node.schema,
				filter: search.value.filter,
			});
			setChildren(
				node.key,
				tables.map((entry) => ({
					kind: "table",
					key: tableKeyOf(node.connectionId, node.database, node.schema, entry.name),
					database: node.database,
					schema: node.schema,
					table: entry.name,
					connectionId: node.connectionId,
				})),
			);
		} else if (node.kind === "table") {
			// A table row is only a container. Its four groups are cheap to build
			// and cost one request each to fill, so opening a table must fire
			// none of them — the user opened it to see its name, and only the
			// group they then expand is a question worth asking the server.
			setChildren(
				node.key,
				groupNodes(node.key, node.connectionId, node.database, node.schema, node.table),
			);
		} else {
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
	} finally {
		setLoading(node.key, false);
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
 * Opens every connection and its container node so a table-name filter has
 * somewhere to match. Sequenced rather than parallel: a server only accepts so
 * much at once, and the awaits are cheap relative to the queries they guard.
 *
 * It stops at the containers on purpose. A table row is left closed, because
 * expanding one fans out into four metadata requests and a filter keystroke
 * must not do that across every table of every connection to reveal matches.
 */
async function expandAll(): Promise<void> {
	const connectionNodes = roots.value;
	for (const node of connectionNodes) {
		setExpanded(node.key, true);
		await loadChildren(node);
	}
	for (const node of connectionNodes) {
		for (const child of childrenOf(node) ?? []) {
			if (child.kind !== "schema") continue;
			setExpanded(child.key, true);
			await loadChildren(child);
		}
	}
}

/**
 * A filter change invalidates every table list, since each was fetched with the
 * previous filter. Dropping the cache is what makes the next expansion refetch;
 * a node the user never opened keeps its (still empty) absence and stays offline.
 *
 * The drop cascades: table rows lose their group rows, group rows lose their
 * leaves, and the fetched metadata goes with them. Holding every list the user
 * ever drilled into would grow without bound, and the tree that shows them has
 * just been rebuilt anyway. The failure marks go too, so a stale empty list
 * can never suppress the retry that would replace it.
 */
function dropTableLists(): void {
	const stale = [`${KEY_PREFIX.schema}|`, `${KEY_PREFIX.table}|`, `${KEY_PREFIX.group}|`];
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

/** Refetches every container node that is currently open, after a cache drop. */
async function reloadOpenContainers(): Promise<void> {
	for (const connection of roots.value) {
		if (!isExpanded(connection)) continue;
		await loadChildren(connection);
		for (const child of childrenOf(connection) ?? []) {
			if (child.kind !== "schema" || !isExpanded(child)) continue;
			await loadChildren(child);
		}
	}
}

watch(
	() => search.value.filter,
	(next, previous) => {
		if (next === previous) return;
		dropTableLists();
		void onSearchChanged(next);
	},
);

async function onSearchChanged(filter: string): Promise<void> {
	try {
		if (filter === "") {
			// Clearing the box restores the unfiltered lists of open containers.
			await reloadOpenContainers();
			return;
		}
		// A `database.table` term is matched across every container, so nothing is
		// force-opened; a bare name has to reveal its own matches.
		if (search.value.scoped) await reloadOpenContainers();
		else await expandAll();
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
	if (node.kind === "connection") return { icon: Server, iconClass: "text-amber-500" };
	if (node.kind === "schema") return { icon: Database, iconClass: "text-yellow-500" };
	if (node.kind === "table") return { icon: Table2, iconClass: "text-green-500" };
	if (node.kind === "group") {
		const group = META_GROUPS[node.group];
		return { icon: group.icon, iconClass: group.iconClass };
	}
	return { iconClass: "text-muted-foreground" };
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
	if (node.kind === "schema") {
		return (childrenOf(node) ?? []).filter((child) => child.kind === "table").length;
	}
	return undefined;
}

/**
 * Row props for one scroller slot. Typed on the slot payload rather than the
 * slot itself so the binding stays fully checked at the `v-bind` site.
 */
function rowBinding(slot: unknown): TreeRowBinding {
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
		// Everything but a leaf expands; a group row opens its list and nothing
		// else, and the twisty is what invites that click.
		hasChildren: node.kind !== "leaf",
		expanded: isExpanded(node),
		selected: selectedKey.value === node.key,
		loading: isLoading(node),
		childCount: childCountOf(node),
		badge: leaf?.badge,
		title: leaf?.title,
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
		onContextmenu: (event: MouseEvent) => onRowContextMenu(node, event),
	};
}

function onRowContextMenu(node: TreeNode, event: MouseEvent): void {
	if (node.kind !== "connection") return;
	menuConnectionId.value = node.id;
	menuAnchor.value = { x: event.clientX, y: event.clientY };
	menuOpen.value = true;
}

function editConnection(): void {
	if (!menuConnectionId.value) return;
	emit("edit-connection", menuConnectionId.value);
}

/**
 * Reveals whatever the active tab points at: opens its ancestors, selects the
 * row and scrolls it into view, so the sidebar says where the work in the
 * workspace came from.
 *
 * Each ancestor is loaded as it is opened, because `flattenTree` only emits a
 * child whose key is in `expanded` *and* whose parent has cached children — so
 * this costs exactly the queries clicking down to the row by hand would. The
 * target is resolved after each load, which is also why a tab whose connection
 * was deleted (or whose container has gone) simply does nothing.
 */
async function locateActiveTab(): Promise<void> {
	const tab = tabs.activeTab;
	if (!tab) return;

	const connection = roots.value.find(
		(node): node is Extract<TreeNode, { kind: "connection" }> =>
			node.kind === "connection" && node.id === tab.connectionId,
	);
	if (!connection) return;

	setExpanded(connection.key, true);
	await loadChildren(connection);

	// The container row's own `database`/`schema` fields are what identify it:
	// its key names the level it lists (the database on MySQL, the default
	// schema elsewhere), which the tab does not necessarily carry.
	const container = (childrenOf(connection) ?? []).find(
		(node): node is Extract<TreeNode, { kind: "schema" }> =>
			node.kind === "schema" &&
			node.database === tab.database &&
			node.schema === tab.schema,
	);
	if (!container) return;

	setExpanded(container.key, true);
	await loadChildren(container);

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
			await loadChildren(table);
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

		<RecycleScroller
			v-else
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
				<TreeRow v-bind="rowBinding(slot)" />
			</template>
		</RecycleScroller>

		<!-- One menu for every row. Rows are virtualised, so a per-row menu
		     would remount with every scroll; this one is parked next to the
		     scroller and anchored at the pointer instead. -->
		<DropdownMenu v-model:open="menuOpen">
			<!-- `as-child` hands the anchor element straight to the popper, so
			     the trigger IS the zero-size element. It is `fixed` because the
			     pointer coordinates are viewport-relative while the sidebar sits
			     offset inside the gutter. -->
			<DropdownMenuTrigger as-child>
				<span
					class="pointer-events-none fixed size-0"
					:style="{
						left: `${menuAnchor.x}px`,
						top: `${menuAnchor.y}px`,
					}"
					aria-hidden="true"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent class="w-48" aria-label="Connection actions">
				<DropdownMenuItem :disabled="!menuConnectionId" @select="editConnection">
					<Pencil aria-hidden="true" />
					Edit connection
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	</div>
</template>