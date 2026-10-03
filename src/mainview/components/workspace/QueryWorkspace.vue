<script setup lang="ts">
/**
 * The right-hand panel: tab strip on top, then a horizontal split between the
 * editor and its results. The split ratio is persisted so a restart lands on
 * the same geometry.
 *
 * A table tab has no editor, so it collapses the split and gives the whole pane
 * to the grid.
 */
import { computed, ref, watch } from "vue";
import { Pane, Splitpanes } from "splitpanes";
import type { SplitpanesResizedPayload } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { FilePlus2Icon, RefreshCwIcon, TriangleAlertIcon } from "lucide-vue-next";
import { useConnectionsStore } from "../../stores/connections";
import { useQueryStore } from "../../stores/query";
import { useTabsStore } from "../../stores/tabs";
import type { Tab } from "../../stores/tabs";
import { toast } from "../../composables/useToast";
import { errorMessage, rpc } from "../../lib/rpc";
import ResultGrid from "./ResultGrid.vue";
import ResultContextRow from "./ResultContextRow.vue";
import SqlEditor from "./SqlEditor.vue";
import StatementBar from "./StatementBar.vue";
import TabStrip from "./TabStrip.vue";
import { Button } from "../ui/button";

const STORAGE_KEY = "recall.resultPaneSize";
/** Result pane bounds, in percent of the workspace height. */
const MIN_RESULT_SIZE = 20;
const MAX_RESULT_SIZE = 85;
const DEFAULT_RESULT_SIZE = 45;
const MIN_EDITOR_SIZE = 15;

/**
 * How many rows a table browse asks for. A typed query is left alone — the
 * user's own LIMIT is theirs to write — but browsing a table has no such limit,
 * and an unbounded `SELECT *` on a large table is the common way to hang a
 * client. The status bar reports when this cuts the result short.
 */
const TABLE_BROWSE_LIMIT = 1000;

function clampResultSize(size: number): number {
	return Math.min(MAX_RESULT_SIZE, Math.max(MIN_RESULT_SIZE, size));
}

function readStoredResultSize(): number {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return DEFAULT_RESULT_SIZE;
		const parsed = Number.parseFloat(raw);
		return Number.isFinite(parsed)
			? clampResultSize(parsed)
			: DEFAULT_RESULT_SIZE;
	} catch {
		// Storage blocked: the split simply starts at its default.
		return DEFAULT_RESULT_SIZE;
	}
}

const resultPaneSize = ref(readStoredResultSize());
const editorPaneSize = computed(() => 100 - resultPaneSize.value);

function onResized(payload: SplitpanesResizedPayload): void {
	const size = clampResultSize(payload.panes[1]?.size ?? DEFAULT_RESULT_SIZE);
	resultPaneSize.value = size;
	try {
		localStorage.setItem(STORAGE_KEY, String(size));
	} catch {
		// Nothing to persist to; the layout still tracks live drags.
	}
}

const tabsStore = useTabsStore();
const queryStore = useQueryStore();
const connectionsStore = useConnectionsStore();

const activeTab = computed(() => tabsStore.activeTab);
const tabId = computed(() => activeTab.value?.id ?? null);
const isTableTab = computed(() => activeTab.value?.mode === "table");

const statements = computed(() =>
	tabId.value ? (queryStore.results[tabId.value] ?? []) : [],
);
const activeStatementIndex = computed(() =>
	tabId.value ? (queryStore.activeStatementIndex[tabId.value] ?? 0) : 0,
);
const activeResult = computed(
	() => statements.value[activeStatementIndex.value] ?? statements.value[0] ?? null,
);

const hasConnection = computed(
	() => connectionsStore.activeId !== null || connectionsStore.configs.length > 0,
);

/**
 * Opens a query tab for whichever connection is current. The database and
 * schema come from the live connection when it is up, and from the saved
 * config otherwise, so the button works before connecting.
 */
function openNewQueryTab(): void {
	const connectionId =
		connectionsStore.activeId ?? connectionsStore.configs[0]?.id;
	if (!connectionId) {
		toast("Add a connection first");
		return;
	}
	const config = connectionsStore.configs.find((entry) => entry.id === connectionId);
	const database =
		connectionsStore.databaseInfo[connectionId]?.currentDatabase ??
		config?.database ??
		"";
	// MySQL's schema is the database itself; Postgres defaults to `public`.
	const schema =
		config?.dbType === "mysql" ? database : (config?.defaultSchema || "public");
	tabsStore.openQueryTab({ connectionId, database, schema, forceNew: true });
}

/** Quotes an identifier the way the connection's server expects it. */
function quoteIdentifier(identifier: string, quote: '"' | "`"): string {
	const escaped = identifier.split(quote).join(quote + quote);
	return `${quote}${escaped}${quote}`;
}

/**
 * The ORDER BY a table tab is currently showing. Kept per tab so switching
 * between two tables does not carry one table's sort onto the other.
 */
const tableSort = ref<Record<string, { column: string; direction: "asc" | "desc" }>>({});

/**
 * The raw WHERE expression typed into the filter row, per tab. It is appended to
 * the generated SELECT verbatim, so it is SQL the user wrote, not a predicate we
 * parse and re-quote.
 */
const tableWhere = ref<Record<string, string>>({});

/** The raw ORDER BY expression typed into the filter row, per tab. */
const tableOrderBy = ref<Record<string, string>>({});

/** Hidden column names per tab, so each table keeps its own column layout. */
const hiddenColumnsByTab = ref<Record<string, string[]>>({});

function hiddenColumnsForTab(id: string | null): Set<string> {
	return new Set(id ? (hiddenColumnsByTab.value[id] ?? []) : []);
}

const activeHiddenColumns = computed(() => hiddenColumnsForTab(tabId.value));
const activeResultColumns = computed(() => activeResult.value?.columns ?? []);
const activeVisibleColumns = computed(() =>
	activeResultColumns.value.filter(
		(name) => !activeHiddenColumns.value.has(name),
	),
);

function setVisibleColumns(next: string[]): void {
	const id = tabId.value;
	if (!id) return;
	const hidden = activeResultColumns.value.filter(
		(name) => !next.includes(name),
	);
	hiddenColumnsByTab.value = { ...hiddenColumnsByTab.value, [id]: hidden };
}

const activeWhere = computed(() =>
	tabId.value ? (tableWhere.value[tabId.value] ?? "") : "",
);
const activeOrderBy = computed(() =>
	tabId.value ? (tableOrderBy.value[tabId.value] ?? "") : "",
);

function setWhere(value: string): void {
	const id = tabId.value;
	if (!id) return;
	tableWhere.value = { ...tableWhere.value, [id]: value };
}

function setOrderBy(value: string): void {
	const id = tabId.value;
	if (!id) return;
	tableOrderBy.value = { ...tableOrderBy.value, [id]: value };
}

/** Enter in a filter field re-runs the statement; a header click must not
 *  clear what the user typed, so the two sorts are independent. */
function applyFilter(): void {
	const tab = activeTab.value;
	if (!tab || tab.mode !== "table") return;
	void loadTable(tab);
}

/**
 * Table tabs are read-only views, so their rows come from one `SELECT *`
 * rather than from the editor. Sorting is applied here rather than in the
 * browser: a result set is already truncated, so sorting the loaded rows would
 * silently rank a prefix of the table instead of the table itself.
 */
function tableSelectSql(tab: Tab): string {
	const config = connectionsStore.configs.find(
		(entry) => entry.id === tab.connectionId,
	);
	const isMysql = config?.dbType === "mysql";
	const quote = isMysql ? "`" : '"';
	const table = quoteIdentifier(tab.table, quote);
	/**
	 * The target has to name the database the table was *listed* under, not the
	 * one the connection happens to be attached to. A bare `table` resolves
	 * against the connection's default database, so browsing any other database
	 * reports "table does not exist" even though the tree listed it.
	 *
	 * Postgres has no cross-database syntax: there, the database is the
	 * connection's and only the schema qualifies the table.
	 */
	const database = tab.database.trim();
	const target =
		isMysql && database
			? `${quoteIdentifier(database, quote)}.${table}`
			: tab.schema
				? `${quoteIdentifier(tab.schema, '"')}.${table}`
				: table;
	// The typed expressions win over the header-click sort: they are the more
	// specific instruction, and `name ASC` cannot be expressed by a single column
	// plus a direction.
	const typedOrderBy = tableOrderBy.value[tab.id]?.trim();
	const sort = tableSort.value[tab.id];
	const orderBy = typedOrderBy
		? ` ORDER BY ${typedOrderBy}`
		: sort
			? ` ORDER BY ${quoteIdentifier(sort.column, quote)} ${sort.direction}`
			: "";
	const where = tableWhere.value[tab.id]?.trim();
	const whereClause = where ? ` WHERE ${where}` : "";
	/**
	 * The row cap is pushed into the statement rather than applied to the result:
	 * the backend truncates after the driver has already materialised every row,
	 * so a client-side cap still pays for the whole table. Both dialects write
	 * LIMIT the same way.
	 */
	return `SELECT * FROM ${target}${whereClause}${orderBy} LIMIT ${TABLE_BROWSE_LIMIT};`;
}

/**
 * Primary key columns for the tab's table, needed to address a row for UPDATE.
 * Cached per tab because the value cannot change while the tab is open.
 */
const keyColumnsByTab = ref<Record<string, string[]>>({});
const keyColumnsLoading = ref<Record<string, boolean>>({});

async function ensureKeyColumns(tab: Tab): Promise<string[]> {
	const cached = keyColumnsByTab.value[tab.id];
	if (cached) return cached;
	if (keyColumnsLoading.value[tab.id]) return [];
	keyColumnsLoading.value[tab.id] = true;
	try {
		// The backend has no open socket until `connect` has finished, so this
		// has to be serialised behind it — otherwise a tab restored from disk
		// reads columns before the connection it names exists.
		await connectionsStore.ensureConnected(tab.connectionId);
		const columns = await rpc.request.listColumns({
			connectionId: tab.connectionId,
			database: tab.database,
			schema: tab.schema,
			table: tab.table,
		});
		const keys = columns
			.filter((column) => column.isPrimaryKey)
			.map((column) => column.name);
		keyColumnsByTab.value[tab.id] = keys;
		return keys;
	} catch (err) {
		toast(errorMessage(err));
		// An empty cache marks the table as keyless so the grid stops retrying
		// on every render; the grid falls back to read-only.
		keyColumnsByTab.value[tab.id] = [];
		return [];
	} finally {
		keyColumnsLoading.value[tab.id] = false;
	}
}

/**
 * Tabs whose table load has been started and has since settled. Reactive so
 * the pane can tell "never attempted" (loading) from "attempted and failed".
 * Doubles as the once-per-session auto-run guard: the watcher below only
 * fires a run while the flag is unset, and only an explicit Retry clears it.
 */
const attemptedTableTabs = ref<Record<string, boolean>>({});

/** Runs the tab's `SELECT *` and records the attempt either way. */
async function loadTable(tab: Tab): Promise<void> {
	try {
		// The profile list decides how the table name is quoted — backticks for
		// MySQL, double quotes for Postgres — and it lives in the backend. A tab
		// restored from disk is often the first thing on screen, so without this
		// the statement gets quoted for Postgres and a MySQL server rejects it.
		await connectionsStore.hydrate();
		await queryStore.run(tab.id, { sqlOverride: tableSelectSql(tab) });
	} catch (err) {
		// `run` reports failures as an error result rather than throwing, so
		// this only covers a store-level throw: surface it instead of letting
		// the promise go unhandled and leaving the pane stuck on "loading".
		toast(errorMessage(err));
	} finally {
		attemptedTableTabs.value[tab.id] = true;
	}
}

watch(
	activeTab,
	(tab) => {
		if (!tab || tab.mode !== "table") return;
		if (attemptedTableTabs.value[tab.id]) return;
		if (queryStore.results[tab.id]) {
			attemptedTableTabs.value[tab.id] = true;
			return;
		}
		void ensureKeyColumns(tab);
		void loadTable(tab);
	},
	// Restored tabs arrive already active, so the first run has to fire on
	// mount too — otherwise a table tab restored from disk never loads.
	{ immediate: true },
);

const isRunning = computed(() =>
	tabId.value ? queryStore.running[tabId.value] === true : false,
);

/** A result worth showing in the grid: present and free of an error. */
const tableResult = computed(() => {
	const result = activeResult.value;
	return result && !result.error ? result : null;
});

/** Loading until a run has been attempted and has settled. */
const tableLoading = computed(
	() => isRunning.value || (tabId.value !== null && attemptedTableTabs.value[tabId.value] !== true),
);

/** The backend's own words, or a generic one if the run produced nothing. */
const tableErrorMessage = computed(
	() => activeResult.value?.error?.message ?? "The table could not be loaded.",
);

const tableErrorDetail = computed(() => activeResult.value?.error?.detail ?? null);

const tableErrorCode = computed(() => activeResult.value?.error?.code ?? null);

/** The SQL that produced the failure, as the store recorded it. */
const tableSql = computed(() => {
	const id = tabId.value;
	const tab = activeTab.value;
	if (id === null || !tab || tab.mode !== "table") return "";
	return queryStore.executedSql[id] ?? tableSelectSql(tab);
});

/**
 * Rebuilds the tab's SELECT with the requested ORDER BY and re-runs it.
 *
 * An empty column is how the grid says "drop the ORDER BY", so it has to
 * delete the tab's entry rather than return early — otherwise clearing the
 * sort would leave the previous ORDER BY standing and the statement on screen
 * would not match what the user just asked for.
 */
function onGridSort(column: string, direction: "asc" | "desc"): void {
	const tab = activeTab.value;
	if (!tab || tab.mode !== "table") return;
	if (!column) {
		if (!tableSort.value[tab.id]) return;
		const next = { ...tableSort.value };
		delete next[tab.id];
		tableSort.value = next;
	} else {
		tableSort.value = { ...tableSort.value, [tab.id]: { column, direction } };
	}
	void loadTable(tab);
}

/**
 * Re-runs whatever the active tab is showing.
 *
 * A table tab is reloaded so its ORDER BY survives; a query tab replays the
 * statement the store last ran, which is what the grid was built from. Editing
 * a cell uses this too, so an edited row comes back from the server rather than
 * from an optimistic local guess.
 */
function rerunActive(): void {
	const tab = activeTab.value;
	const id = tabId.value;
	if (!tab || !id) return;
	if (tab.mode === "table") {
		void loadTable(tab);
		return;
	}
	const sql = queryStore.executedSql[id];
	if (!sql) {
		toast("Nothing has been run in this tab yet");
		return;
	}
	void queryStore.run(id, { sqlOverride: sql });
}

/** What the grid is allowed to edit: a table tab that has a primary key. */
const editableTarget = computed(() => {
	const tab = activeTab.value;
	if (!tab || tab.mode !== "table") return null;
	const keys = keyColumnsByTab.value[tab.id];
	if (!keys || keys.length === 0) return null;
	return {
		connectionId: tab.connectionId,
		database: tab.database,
		schema: tab.schema,
		table: tab.table,
		keyColumns: keys,
	};
});

/** CSV quoting is per RFC 4180: quote when the value holds a delimiter, quote
 *  or newline, and double any embedded quote. */
function csvCell(value: unknown): string {
	const text = value === null || value === undefined ? "" : String(value);
	return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportResult(format: "csv" | "json"): Promise<void> {
	const tab = activeTab.value;
	const result = activeResult.value;
	if (!tab || !result || result.rows.length === 0) return;
	try {
		const picked = await rpc.request.pickFolder(
			{},
			{ maxRequestTime: Infinity },
		);
		if (!picked) return;

		const contents =
			format === "csv"
				? [
						result.columns.map(csvCell).join(","),
						...result.rows.map((row) =>
							result.columns
								.map((_, index) => csvCell(Array.isArray(row) ? row[index] : null))
								.join(","),
						),
					].join("\n")
				: JSON.stringify(
						result.rows.map((row) => {
							const record: Record<string, unknown> = {};
							result.columns.forEach((column, index) => {
								record[column] = Array.isArray(row) ? row[index] : null;
							});
							return record;
						}),
						null,
						2,
					);

		const { path } = await rpc.request.exportResult(
			{ folder: picked, fileName: `${tab.title}.${format}`, contents },
			{ maxRequestTime: 30_000 },
		);
		toast(`Exported ${result.rows.length} rows to ${path}`);
	} catch (err) {
		toast(errorMessage(err));
	}
}

function retryTable(): void {
	const tab = activeTab.value;
	if (!tab || tab.mode !== "table") return;
	// Back to "loading" until the new run settles; the watcher does not
	// re-fire, so this is an explicit retry rather than a second auto-run.
	attemptedTableTabs.value[tab.id] = false;
	void loadTable(tab);
}
</script>

<template>
	<div class="panel flex h-full flex-col" data-slot="query-workspace">
		<TabStrip @new-tab="openNewQueryTab" />

		<div
			v-if="!activeTab"
			class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3"
		>
			<p class="text-sm text-muted-foreground">No open tabs</p>
			<Button
				variant="outline"
				size="sm"
				:disabled="!hasConnection"
				@click="openNewQueryTab"
			>
				<FilePlus2Icon aria-hidden="true" />
				New query tab
			</Button>
		</div>

		<!-- A table tab has no editor: the grid takes the whole pane. -->
		<Splitpanes v-else-if="isTableTab" horizontal class="min-h-0 flex-1">
			<Pane :size="100" class="flex min-h-0 flex-col">
				<StatementBar v-if="tabId" :tab-id="tabId" />
				<ResultContextRow
					v-if="activeTab"
					:connection-id="activeTab.connectionId"
					:database="activeTab.database"
					:schema="activeTab.schema"
					:table="activeTab.table || undefined"
					:columns="activeResultColumns"
					:visible-columns="activeVisibleColumns"
					@update:visible-columns="setVisibleColumns"
				/>
				<ResultGrid
					v-if="tableResult"
					:result="tableResult"
					:editable="editableTarget"
					:busy="isRunning"
					:filterable="isTableTab"
					:hidden-columns="activeHiddenColumns"
					:where="activeWhere"
					:order-by="activeOrderBy"
					@rerun="rerunActive"
					@sort="onGridSort"
					@export="exportResult"
					@update:where="setWhere"
					@update:order-by="setOrderBy"
					@apply-filter="applyFilter"
				/>
				<p
					v-else-if="tableLoading"
					class="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground"
				>
					Loading table…
				</p>
				<!-- Failed: same treatment ResultGrid gives a statement error. -->
				<div
					v-else
					class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-4 text-center select-text"
				>
					<TriangleAlertIcon
						class="size-5 shrink-0 text-destructive"
						aria-hidden="true"
					/>
					<p class="text-xs text-muted-foreground">The table failed to load</p>
					<p
						class="max-w-[36rem] break-words whitespace-pre-wrap font-mono text-xs text-destructive"
					>
						{{ tableErrorMessage }}
					</p>
					<p
						v-if="tableErrorDetail"
						class="max-w-[36rem] break-words whitespace-pre-wrap text-[11px] text-muted-foreground"
					>
						{{ tableErrorDetail }}
					</p>
					<div
						class="mt-1 flex flex-wrap items-center justify-center gap-2 text-[11px] text-muted-foreground"
					>
						<code v-if="tableSql" class="rounded border border-border px-1 font-mono">{{
							tableSql
						}}</code>
						<code v-if="tableErrorCode" class="rounded border border-border px-1 font-mono">{{
							tableErrorCode
						}}</code>
					</div>
					<Button
						class="mt-1"
						variant="outline"
						size="sm"
						:disabled="isRunning"
						@click="retryTable"
					>
						<RefreshCwIcon aria-hidden="true" />
						Retry
					</Button>
				</div>
			</Pane>
		</Splitpanes>

		<Splitpanes
			v-else
			horizontal
			class="min-h-0 flex-1"
			@resized="onResized"
		>
			<Pane :size="editorPaneSize" :min-size="MIN_EDITOR_SIZE" class="flex min-h-0 flex-col">
				<SqlEditor />
			</Pane>
			<Pane
				:size="resultPaneSize"
				:min-size="MIN_RESULT_SIZE"
				:max-size="MAX_RESULT_SIZE"
				class="flex min-h-0 flex-col"
			>
				<StatementBar v-if="tabId" :tab-id="tabId" />
				<ResultGrid v-if="activeResult" :result="activeResult" />
				<p
					v-else
					class="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-xs text-muted-foreground"
				>
					Run the query to see results.
				</p>
			</Pane>
		</Splitpanes>
	</div>
</template>
