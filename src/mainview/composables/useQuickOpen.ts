/**
 * Quick Open: one ranked list of tables, SQL files and connections.
 *
 * The palette's state is module-level, like the toast state, and deliberately
 * so. The palette is opened from the window shell (a Cmd/Ctrl+P listener) and
 * rendered by a dialog component, so the two cannot share a component
 * instance — but they must share the same `open` flag and the same query. A
 * singleton here is what makes that work without a provider in the tree.
 *
 * The stores are *not* taken at module scope: this module is imported before
 * `createApp(...).use(createPinia())` runs, so a module-level `useStore()` would
 * have no active pinia. Each `useQuickOpen()` call resolves them instead, and
 * every call gets the same underlying stores.
 */
import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import type { TableInfo } from "../../shared/types";
import type { FileDatasource, SqlFileNode } from "../../shared/sqlFile";
import { useConnectionsStore } from "../stores/connections";
import { useSqlFilesStore } from "../stores/sqlFiles";
import { useTabsStore } from "../stores/tabs";
import { toast } from "./useToast";
import { errorMessage } from "../lib/rpc";
import { matchFuzzy } from "../lib/fuzzy";

export type QuickOpenItem =
	| {
			kind: "table";
			id: string;
			label: string;
			description: string;
			connectionId: string;
			database: string;
			schema: string;
			table: string;
	  }
	| {
			kind: "file";
			id: string;
			label: string;
			description: string;
			path: string;
			connectionId: string;
			database: string;
			schema: string;
	  }
	| {
			kind: "connection";
			id: string;
			label: string;
			description: string;
			connectionId: string;
	  };

/**
 * Tables already fetched, per connection. A connection's table list is fixed
 * for the session, so an entry is never evicted; a failed fetch stores nothing
 * and is retried on the next palette open.
 */
const tableCache = new Map<string, TableInfo[]>();
/** Connections with a fetch in flight, so a burst of keystrokes is one query. */
const inFlight = new Set<string>();
/** Bumped on every completed fetch. The cache is a plain Map and so is not
 * reactive; this is the one dependency `items` needs to watch instead. */
const cacheVersion = ref(0);

const open = ref(false);
const query = ref("");

/** Guards the module-level `watch` below against being installed twice. */
let watchingOpen = false;

/** Rows rendered at once. Beyond this the list is a scrollbar, not a list. */
const MAX_RESULTS = 50;

/** Order the kinds are shown in when scores tie. */
const KIND_ORDER: Record<QuickOpenItem["kind"], number> = {
	table: 0,
	file: 1,
	connection: 2,
};

/** Depth-first flatten of one folder's scan into its non-directory nodes. */
function flatten(nodes: SqlFileNode[], into: SqlFileNode[]): void {
	for (const node of nodes) {
		if (node.isDir) flatten(node.children, into);
		else into.push(node);
	}
}

/** What {@link useQuickOpen} hands back: the shared palette state and its
 * three actions. */
export interface QuickOpenPalette {
	open: Ref<boolean>;
	query: Ref<string>;
	items: ComputedRef<QuickOpenItem[]>;
	loadTables(connectionId: string): Promise<void>;
	activate(item: QuickOpenItem): Promise<void>;
	close(): void;
}

export function useQuickOpen(): QuickOpenPalette {
	const connections = useConnectionsStore();
	const sqlFiles = useSqlFilesStore();
	const tabs = useTabsStore();

	/**
	 * The datasource a file opens against: its binding when that binding's
	 * connection still exists, otherwise the active connection's own database
	 * and schema. Null when there is no connection at all — the file is then not
	 * listed, because there would be nothing to run it against.
	 */
	function datasourceFor(path: string): FileDatasource | null {
		const bound = sqlFiles.bindingFor(path);
		if (bound && connections.configs.some((c) => c.id === bound.connectionId)) {
			return bound;
		}
		const config =
			connections.configs.find((c) => c.id === connections.activeId) ??
			connections.configs[0];
		if (!config) return null;
		return {
			connectionId: config.id,
			database: config.database,
			schema: config.dbType === "postgres" ? config.defaultSchema : "",
		};
	}

	/**
	 * Fetches one connection's table list into the cache. Never rejects: a
	 * connection that is down, unreachable or not permitted is skipped, so one
	 * bad profile cannot empty the palette for the others.
	 */
	async function loadTables(connectionId: string): Promise<void> {
		if (tableCache.has(connectionId) || inFlight.has(connectionId)) return;
		const config = connections.configs.find((entry) => entry.id === connectionId);
		if (!config) return;

		inFlight.add(connectionId);
		try {
			tableCache.set(
				connectionId,
				await connections.listTables({
					connectionId,
					database: config.database,
					// Postgres names a schema; MySQL's schema *is* its database.
					schema:
						config.dbType === "postgres" ? config.defaultSchema : config.database,
					filter: "",
				}),
			);
		} catch {
			// Left uncached on purpose: the next palette open retries it, which
			// is what a user who just fixed their VPN expects.
		} finally {
			inFlight.delete(connectionId);
			cacheVersion.value += 1;
		}
	}

	/** Hides the palette and clears the query, so the next open starts fresh. */
	function close(): void {
		open.value = false;
		query.value = "";
	}

	/** Opens whatever the picked row points at, then closes the palette. */
	async function activate(item: QuickOpenItem): Promise<void> {
		try {
			if (item.kind === "table") {
				const tab = tabs.openTableTab({
					connectionId: item.connectionId,
					database: item.database,
					schema: item.schema,
					table: item.table,
				});
				tabs.activate(tab.id);
				await connections.ensureConnected(item.connectionId);
			} else if (item.kind === "file") {
				await connections.ensureConnected(item.connectionId);
				const { content } = await sqlFiles.read(item.path);
				const tab = tabs.openQueryTab({
					connectionId: item.connectionId,
					database: item.database,
					schema: item.schema,
					sql: content,
				});
				// The tabs store titles every query "Query"; a file's own name is
				// what makes several of them tellable apart.
				tabs.rename(tab.id, item.label);
			} else {
				await connections.connect(item.connectionId);
			}
		} catch (err) {
			toast(errorMessage(err));
		}
		close();
	}

	/** Every configured connection and every cached table, as palette rows. */
	function connectionRows(): QuickOpenItem[] {
		const rows: QuickOpenItem[] = connections.configs.map((config) => ({
			kind: "connection",
			id: config.id,
			label: config.name,
			description: `${config.dbType} · ${config.host}:${config.port} · ${config.database}`,
			connectionId: config.id,
		}));
		for (const config of connections.configs) {
			const schema =
				config.dbType === "postgres" ? config.defaultSchema : config.database;
			for (const entry of tableCache.get(config.id) ?? []) {
				rows.push({
					kind: "table",
					id: `${config.id} ${config.database} ${schema} ${entry.name}`,
					label: entry.name,
					description: `${config.name} / ${config.database} / ${schema}`,
					connectionId: config.id,
					database: config.database,
					schema,
					table: entry.name,
				});
			}
		}
		return rows;
	}

	/** Every opened `.sql` file, as palette rows. Non-SQL files are skipped
	 * even when the folder's filter is widened: the palette is for SQL. */
	function fileRows(): QuickOpenItem[] {
		const nodes: SqlFileNode[] = [];
		for (const folder of sqlFiles.folders) {
			flatten(sqlFiles.trees[folder] ?? [], nodes);
		}
		const rows: QuickOpenItem[] = [];
		for (const node of nodes) {
			if (!node.name.toLowerCase().endsWith(".sql")) continue;
			const datasource = datasourceFor(node.path);
			if (!datasource) continue;
			rows.push({
				kind: "file",
				id: node.path,
				label: node.name,
				description: node.path.slice(0, node.path.lastIndexOf("/")) || "/",
				path: node.path,
				connectionId: datasource.connectionId,
				database: datasource.database,
				schema: datasource.schema,
			});
		}
		return rows;
	}

	/** Rows of one kind before another, then alphabetically. */
	const byKindThenLabel = (a: QuickOpenItem, b: QuickOpenItem): number =>
		KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label);

	/**
	 * The ranked result list. A blank query lists everything by kind, so opening
	 * the palette is never a dead end; anything else is filtered and scored by
	 * {@link matchFuzzy}. A table is matched on its own name and a file on its
	 * base name — both are the row's `label`.
	 */
	const items = computed<QuickOpenItem[]>(() => {
		void cacheVersion.value;
		const all = [...connectionRows(), ...fileRows()];
		const needle = query.value.trim();
		if (!needle) return all.sort(byKindThenLabel).slice(0, MAX_RESULTS);

		const scored: { item: QuickOpenItem; score: number }[] = [];
		for (const item of all) {
			const match = matchFuzzy(needle, item.label);
			if (match) scored.push({ item, score: match.score });
		}
		scored.sort((a, b) => a.score - b.score || byKindThenLabel(a.item, b.item));
		return scored.slice(0, MAX_RESULTS).map((entry) => entry.item);
	});

	if (!watchingOpen) {
		watchingOpen = true;
		// Prime the active connection's tables as the palette opens, so the
		// first keystroke already has something to rank.
		watch(open, (isOpen) => {
			if (isOpen && connections.activeId) void loadTables(connections.activeId);
		});
	}

	return { open, query, items, loadTables, activate, close };
}
