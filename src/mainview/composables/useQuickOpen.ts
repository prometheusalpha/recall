/**
 * Quick Open: one ranked list of tables, SQL files and connections.
 *
 * The state is module-level like the toast state: the window shell (Cmd/Ctrl+P)
 * and the dialog cannot share a component instance and must still share `open`
 * and `query`. The stores are *not* taken at module scope — this file is
 * imported before `createApp().use(createPinia())` runs. Search spans *every*
 * connection, not the active one: `activeId` is written only inside `connect()`,
 * so an active-only palette had nothing to rank.
 */
import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import type { FileDatasource, SqlFileNode } from "../../shared/sqlFile";
import { useConnectionsStore } from "../stores/connections";
import { useSqlFilesStore } from "../stores/sqlFiles";
import { useTabsStore } from "../stores/tabs";
import { resolveFileDatasource } from "../lib/fileDatasource";
import { toast } from "./useToast";
import { errorMessage } from "../lib/rpc";
import { matchFuzzy } from "../lib/fuzzy";
import { useTableCatalog } from "./useTableCatalog";

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

const open = ref(false);
const query = ref("");

/** Guards the module-level `watch` below against being installed twice. */
let watchingOpen = false;

/** Rows rendered at once. Beyond this the list is a scrollbar, not a list. */
const MAX_RESULTS = 50;

/**
 * How long a keystroke burst is allowed to run before the palette asks every
 * connection for its tables. Long enough to swallow a fast typist's whole word,
 * short enough that the first results land while they are still typing — and
 * this bounds how often a fan-out may open a fresh socket, which is what it now
 * costs for a profile that has never been connected.
 */
const FAN_OUT_DEBOUNCE_MS = 200;

/**
 * The pending fan-out timer, module-level because the palette has exactly one
 * query, so it has exactly one pending fan-out. A keystroke replaces the timer
 * rather than queueing behind it, which is what keeps N connections × M
 * keystrokes of `listTables` from happening.
 */
let fanOutTimer: number | undefined;

/**
 * True from the keystroke that schedules a fan-out until every connection it
 * asked has answered. Without it the palette renders its "no matches" row
 * through the whole debounce window and again through every slow connection,
 * which reads as "this table does not exist" at exactly the moment the user is
 * deciding whether to keep typing.
 */
const searching = ref(false);

/**
 * Order the kinds are shown in when scores tie. {@link KINDS} is the same order
 * as an array, for the blank-query interleave that consumes it.
 */
const KIND_ORDER: Record<QuickOpenItem["kind"], number> = {
	table: 0,
	file: 1,
	connection: 2,
};

/** The kinds, in {@link KIND_ORDER} order. */
const KINDS: QuickOpenItem["kind"][] = ["table", "file", "connection"];

/** Depth-first flatten of one folder's scan into its non-directory nodes. */
function flatten(nodes: SqlFileNode[], into: SqlFileNode[]): void {
	for (const node of nodes) {
		if (node.isDir) flatten(node.children, into);
		else into.push(node);
	}
}

/**
 * What {@link useQuickOpen} hands back: the shared palette state and its three
 * actions. Unchanged by the split — the dialog component consumes exactly this.
 */
export interface QuickOpenPalette {
	open: Ref<boolean>;
	query: Ref<string>;
	items: ComputedRef<QuickOpenItem[]>;
	searching: Ref<boolean>;
	loadTables(connectionId: string): Promise<void>;
	activate(item: QuickOpenItem): Promise<void>;
	close(): void;
}

export function useQuickOpen(): QuickOpenPalette {
	const connections = useConnectionsStore();
	const sqlFiles = useSqlFilesStore();
	const tabs = useTabsStore();
	const catalog = useTableCatalog();

	/**
	 * The datasource a file opens against: its binding when that binding's
	 * connection still exists, otherwise the active connection's own database and
	 * schema. Null when there is no connection at all — the file is then not
	 * listed, because there would be nothing to run it against.
	 */
	function datasourceFor(path: string): FileDatasource | null {
		return (
			resolveFileDatasource(
				path,
				sqlFiles.bindings,
				connections.configs,
				connections.activeId,
			)?.datasource ?? null
		);
	}

	/**
	 * Asks *every* configured connection to discover itself and holds
	 * {@link searching} up until they have all answered. `loadTables` skips the
	 * ones already discovered or in flight, but each undiscovered connection is a
	 * real round trip — hence the debounce.
	 *
	 * This is the palette's only eager connection opener, reached only from a
	 * keystroke. Deliberate: a bare open would put a socket to every server in
	 * the sidebar for a user who only wanted to look.
	 */
	function fanOutTables(): void {
		const pending = connections.configs.map((config) =>
			catalog.loadTables(config.id),
		);
		if (pending.length === 0) {
			searching.value = false;
			return;
		}
		// Every `loadTables` resolves — a dead connection is recorded and skipped
		// inside it — so one unreachable profile cannot leave the palette
		// "searching" forever over rows that already arrived.
		void Promise.all(pending).then(() => {
			searching.value = false;
			catalog.reportFanOut();
		});
	}

	/**
	 * Debounces {@link fanOutTables} to one call per pause in typing. A later
	 * keystroke cancels the pending timer outright — the fan-out is "reconsider
	 * after the user stops", not "run once per character".
	 */
	function scheduleFanOut(): void {
		clearTimeout(fanOutTimer);
		searching.value = true;
		// `window.setTimeout`, not the bare global: this module is renderer-only,
		// and the ambient `@types/node` overload of the bare global returns a
		// different handle type than the one stored above.
		fanOutTimer = window.setTimeout(() => {
			fanOutTimer = undefined;
			fanOutTables();
		}, FAN_OUT_DEBOUNCE_MS);
	}

	/**
	 * Hides the palette and clears the query, so the next open starts fresh. The
	 * pending fan-out is dropped with it: nobody is looking at the rows it would
	 * produce, and the next open re-arms the timer anyway.
	 */
	function close(): void {
		open.value = false;
		query.value = "";
		clearTimeout(fanOutTimer);
		fanOutTimer = undefined;
		searching.value = false;
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
				// No eager connect: the file is read locally and the connection is
				// asserted by the query path when the tab is run.
				const { content } = await sqlFiles.read(item.path);
				const tab = tabs.openQueryTab({
					connectionId: item.connectionId,
					database: item.database,
					schema: item.schema,
					sql: content,
					path: item.path,
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

	/** Every configured connection and every discovered table, as palette rows. */
	function connectionRows(): QuickOpenItem[] {
		const rows: QuickOpenItem[] = connections.configs.map((config) => ({
			kind: "connection",
			id: config.id,
			label: config.name,
			description: `${config.dbType} · ${config.host}:${config.port} · ${config.database}`,
			connectionId: config.id,
		}));
		for (const config of connections.configs) {
			catalog.eachDiscoveredTable(config.id, (cached) => {
				for (const entry of cached.tables) {
					rows.push({
						kind: "table",
						id: `${config.id} ${cached.database} ${cached.schema} ${entry.name}`,
						label: entry.name,
						description: `${config.name} / ${cached.database} / ${cached.schema}`,
						connectionId: config.id,
						// The pair the fetch *ran* in, not the profile's current one:
						// a row claiming any other database would open a table that
						// is not there. It is now a found pair rather than a guess,
						// which is also what tells two same-named tables apart.
						database: cached.database,
						schema: cached.schema,
						table: entry.name,
					});
				}
			});
		}
		return rows;
	}

	/**
	 * Every opened `.sql` file, as palette rows. Non-SQL files are skipped even
	 * when the folder's filter is widened: the palette is for SQL.
	 */
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
	 * Blank-query ordering: one row of each kind in turn, then the next. The plain
	 * kind-then-label sort puts *every* connection ahead of *every* table, so a
	 * user with more than {@link MAX_RESULTS} profiles is shown no tables at all —
	 * and with a blank query there is no hit to rank them by, which is the whole
	 * point of opening the palette. Tables come first here by {@link KIND_ORDER},
	 * so the crowded-out case lands on files rather than on the tables the
	 * fan-out exists to surface.
	 */
	function interleaveKinds(rows: QuickOpenItem[]): QuickOpenItem[] {
		const queues: QuickOpenItem[][] = KINDS.map(() => []);
		for (const row of rows) queues[KIND_ORDER[row.kind]].push(row);
		for (const queue of queues) queue.sort(byKindThenLabel);
		const out: QuickOpenItem[] = [];
		while (out.length < MAX_RESULTS) {
			// A blank query opens on "everything", so stop as soon as a full
			// round produced nothing rather than looping over empty queues.
			const queue = queues.find((candidate) => candidate.length > 0);
			if (!queue) break;
			const row = queue.shift();
			if (row) out.push(row);
		}
		return out;
	}

	/**
	 * The ranked result list. A blank query lists everything, interleaved by kind,
	 * so opening the palette is never a dead end and never shows only
	 * connections; anything else is filtered and scored by {@link matchFuzzy}. A
	 * table is matched on its own name and a file on its base name — both are the
	 * row's `label`. The catalog's version counter is the reactive dependency
	 * standing in for a reactive Map.
	 */
	const items = computed<QuickOpenItem[]>(() => {
		void catalog.version.value;
		const all = [...connectionRows(), ...fileRows()];
		const needle = query.value.trim();
		if (!needle) return interleaveKinds(all);

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
		// A bare palette open touches the active connection and nothing else. That
		// is safe to do eagerly because `activeId` is written in exactly one
		// place — inside `connect()` — so a non-null id means that profile is
		// already up and `loadTables` opens no socket. On a fresh launch
		// `activeId` is null and even this does not run. Opening the palette then
		// never talks to a server the user has not already talked to; it only
		// makes the first keystroke's ranking immediate.
		watch(open, (isOpen) => {
			if (isOpen && connections.activeId) void catalog.loadTables(connections.activeId);
		});
		// A non-empty query is what reaches the connections the user has not
		// connected to, and connecting them is its cost — so it is what gates it.
		// A keystroke is a claim that the answer is somewhere, and the only moment
		// that justifies a socket to every saved profile. It watches `query` rather
		// than the open event for the same reason: the active connection primed
		// above is not the one holding the table whose name is being typed.
		watch(query, (value) => {
			if (!open.value || !value.trim()) return;
			scheduleFanOut();
		});
	}

	return {
		open,
		query,
		items,
		searching,
		loadTables: catalog.loadTables,
		activate,
		close,
	};
}