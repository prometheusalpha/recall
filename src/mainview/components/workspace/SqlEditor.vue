<script setup lang="ts">
/**
 * CodeMirror 6 SQL editor, lazy-loaded.
 *
 * Every `@codemirror/*` package is reached through `loadRuntime()`'s dynamic
 * `import()`s, so the editor lands in its own chunk and never in the entry
 * bundle. The `EditorView` is created once and reused for the life of the
 * component: switching tabs swaps the document through a `StateEffect` on a
 * `StateField` instead of tearing the view down.
 *
 * The document and the store are two-way bound — `docChanged` writes the new
 * text back to `tab.sql`, and a tab switch replaces the document wholesale.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
	Check,
	ChevronDown,
	PlayIcon,
	SquareIcon,
} from "lucide-vue-next";
import { useConnectionsStore } from "../../stores/connections";
import { useQueryStore } from "../../stores/query";
import { useTabsStore } from "../../stores/tabs";
import type { Tab } from "../../stores/tabs";
import { useSnippetsStore } from "../../stores/snippets";
import { useBookmarksStore } from "../../stores/bookmarks";
import { useSqlFilesStore } from "../../stores/sqlFiles";
import { useTheme } from "../../composables/useTheme";
import { splitSqlStatements } from "../../lib/sqlSplit";
import { statementAt } from "../../lib/statementAt";
import { errorMessage, rpc, RPC_TIMEOUTS } from "../../lib/rpc";
import type { ConnectionConfig, DatabaseType } from "../../../shared/types";
import type * as CmView from "@codemirror/view";
import type * as CmState from "@codemirror/state";
import type * as CmCommands from "@codemirror/commands";
import type * as CmSearch from "@codemirror/search";
import type * as CmLangSql from "@codemirror/lang-sql";
import type * as CmLanguage from "@codemirror/language";
import type * as OneDarkModule from "@codemirror/theme-one-dark";
import type * as CmAutocomplete from "@codemirror/autocomplete";
import type * as SqlDialectModule from "../../lib/sqlDialect";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "../ui/dropdown-menu";
import { toast } from "../../composables/useToast";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { snippetCompletionSource } from "../editor/SqlCompletionSource";

/* -------------------------------------------------------------------------
 * Lazy runtime
 * ---------------------------------------------------------------------- */

/**
 * Shape of the editor runtime. Each entry is a module namespace object.
 *
 * The namespaces are declared with erased `import type * as` statements above,
 * so the dependency graph is explicit and the type checker can see them — but
 * no runtime import is emitted. The values themselves still arrive lazily via
 * `loadRuntime()`, which is what keeps CodeMirror out of the entry chunk.
 */
interface CmRuntime {
	view: typeof CmView;
	state: typeof CmState;
	commands: typeof CmCommands;
	search: typeof CmSearch;
	langSql: typeof CmLangSql;
	language: typeof CmLanguage;
	/**
	 * `closeBrackets` belongs to `@codemirror/autocomplete`, which
	 * `@codemirror/language` does not re-export, and the token palette comes
	 * from its own theme package — so each arrives from its own namespace.
	 */
	autocomplete: typeof CmAutocomplete;
	/** One Dark: token palette plus its own editor chrome. */
	oneDark: typeof OneDarkModule;
	/**
	 * Our dialect table lives beside `@codemirror/lang-sql`, so it has to come
	 * in lazily too or it drags the language package along.
	 */
	dialect: typeof SqlDialectModule;
}

let runtime: Promise<CmRuntime> | null = null;

/** Loads the editor exactly once per window; every call shares the promise. */
function loadRuntime(): Promise<CmRuntime> {
	runtime ??= Promise.all([
		import("@codemirror/view"),
		import("@codemirror/state"),
		import("@codemirror/commands"),
		import("@codemirror/search"),
		import("@codemirror/lang-sql"),
		import("@codemirror/language"),
		import("@codemirror/autocomplete"),
		import("@codemirror/theme-one-dark"),
		import("../../lib/sqlDialect"),
	]).then(
		([
			view,
			state,
			commands,
			search,
			langSql,
			language,
			autocomplete,
			oneDark,
			dialect,
		]) => ({
			view,
			state,
			commands,
			search,
			langSql,
			language,
			autocomplete,
			oneDark,
			dialect,
		}),
	);
	return runtime;
}

/* -------------------------------------------------------------------------
 * Component state
 * ---------------------------------------------------------------------- */

const tabsStore = useTabsStore();
const queryStore = useQueryStore();
const connectionsStore = useConnectionsStore();
const bookmarksStore = useBookmarksStore();

/**
 * Set between `Mod-F11` and the character the user then presses. The gutter
 * glyph is the only feedback a jump target gets, so the next key is swallowed
 * whether or not the assignment succeeds.
 */
const awaitingMnemonic = ref(false);

/** The 36 characters a mnemonic can be; one slot each, no more. */
const MNEMONICS = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Binds `mnemonic` to the caret's line of the open file. Both entry points —
 * `Ctrl-Shift-<character>` and the character typed after `Ctrl-F11` — land
 * here; the key is swallowed either way, so a shortcut never types itself into
 * the document.
 */
function setBookmarkHere(mnemonic: string): boolean {
	const tab = activeTab.value;
	if (!editor) {
		toast("The editor is still loading");
		return true;
	}
	if (!tab?.path) {
		// A tab only carries a path when it was opened from a file. One restored
		// from an earlier session — before bookmarks existed — has none, and no
		// amount of looking at its SQL can say which file it came from.
		toast(
			"This tab is not a file tab. Open the .sql from the Files panel, then assign again.",
			6000,
		);
		return true;
	}
	const line = editor.currentLine();
	void bookmarksStore.assign(mnemonic, tab.path, line, editor.lineText(line));
	return true;
}

/**
 * Handles a bare character. Returns false when no mnemonic was being asked
 * for, which is what lets the same binding stay mounted for every character
 * without swallowing typing: an unhandled binding falls through to the next
 * one, and then to the document.
 */
function assignMnemonic(pressed: string): boolean {
	if (!awaitingMnemonic.value) return false;
	awaitingMnemonic.value = false;
	return setBookmarkHere(pressed);
}

/** Asks for the mnemonic, then the character that names it. */
function beginAssign(): boolean {
	awaitingMnemonic.value = true;
	return true;
}

/** Escape backs out of asking for a mnemonic. */
function cancelAssign(): boolean {
	if (!awaitingMnemonic.value) return false;
	awaitingMnemonic.value = false;
	return true;
}

/**
 * The keymap bookmarks need. Jumping is not here: `Ctrl-<character>` is
 * handled on the window, because a CodeMirror keymap only sees keys while the
 * editor holds focus, and a jump is exactly the shortcut that has to work
 * from the sidebar, the files panel or with no query tab open at all. What
 * stays is assigning — `Ctrl-Shift-<character>` (handled as a DOM event
 * below) or `Ctrl-F11` followed by one of the 36 characters — because that
 * one needs the caret, and therefore the editor.
 */
function bookmarkBindings(): CmView.KeyBinding[] {
	const bindings: CmView.KeyBinding[] = [
		{ key: "Ctrl-F11", preventDefault: true, run: () => beginAssign() },
		{ key: "Escape", run: () => cancelAssign() },
	];
	for (const mnemonic of MNEMONICS) {
		bindings.push({ key: mnemonic, run: () => assignMnemonic(mnemonic) });
	}
	return bindings;
}

/**
 * The mnemonic a `Ctrl-Shift-<key>` press names, read from the physical key
 * rather than the character: on a US layout `Shift+1` reports `!`, so `key`
 * cannot say which number was pressed. `code` is the keyboard's own name for
 * the key and does not move with the layout.
 */
function mnemonicForShiftKey(event: KeyboardEvent): string | null {
	if (event.altKey || event.metaKey || !event.ctrlKey || !event.shiftKey) {
		return null;
	}
	if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
	const digit = /^Digit([0-9])$/.exec(event.code);
	return digit ? digit[1] : null;
}

/**
 * `Ctrl-Shift-<character>` assigns in one keystroke.
 *
 * This is a DOM handler rather than a keymap entry because CodeMirror derives a
 * printable key's case from Shift instead of recording it as a modifier, which
 * leaves no way to spell `Ctrl-Shift-1` as a key name. Preventing the default
 * is what keeps the window-level jump handler — which replaced this keymap's
 * own `Mod-<character>` entries — from also reading the press as a jump.
 */
function assignFromShortcut(event: KeyboardEvent): boolean {
	const mnemonic = mnemonicForShiftKey(event);
	if (!mnemonic) return false;
	event.preventDefault();
	beginAssignFor(mnemonic);
	return true;
}

/** `Ctrl-Shift-<character>` assigns in one keystroke, with nothing to pick. */
function beginAssignFor(mnemonic: string): boolean {
	awaitingMnemonic.value = false;
	return setBookmarkHere(mnemonic);
}

const snippetsStore = useSnippetsStore();

const host = ref<HTMLDivElement | null>(null);
const editorReady = ref(false);

const activeTab = computed(() => tabsStore.activeTab);
const activeTabId = computed(() => activeTab.value?.id ?? null);
const running = computed(() =>
	activeTabId.value ? queryStore.running[activeTabId.value] === true : false,
);
const statementCount = computed(() =>
	splitSqlStatements(activeTab.value?.sql ?? "").length,
);

/** Table tabs render as a read-only view; query tabs are editable. */
const readOnly = computed(() => activeTab.value?.mode === "table");

const dbType = computed<DatabaseType>(() => {
	const connectionId = activeTab.value?.connectionId;
	const config = connectionId
		? connectionsStore.configs.find((entry) => entry.id === connectionId)
		: undefined;
	return config?.dbType ?? "postgres";
});

function run(): void {
	const id = activeTabId.value;
	if (id) void queryStore.run(id);
}

function stop(): void {
	const id = activeTabId.value;
	if (id) void queryStore.cancel(id);
}

function toggleRun(): void {
	if (running.value) stop();
	else run();
}

/**
 * `Mod-Enter`, in descending order of how much the user narrowed the run:
 * a run in flight, then the selection, then the statement under the caret,
 * then the whole document.
 *
 * A selection is how a user says "these two statements, not the whole file",
 * and running the rest of the document alongside it is how a DDL batch turns
 * into an accident — so a selection beats everything below it, even one that
 * spans two statements. A whitespace-only selection counts as no selection.
 *
 * With nothing selected, the caret itself is the pointer. DataGrip's rule is
 * the one worth copying: put the cursor inside a statement and run only that
 * statement, because "run the file" from the middle of one query is almost
 * never what the user meant. The caret in the blank line between two
 * statements belongs to neither, and that is the honest answer — the run
 * falls through to the whole document, which is what the user had before the
 * outline existed and is still what the toolbar button does.
 *
 * A run in flight always wins: the chord is a toggle first, and stopping a
 * query the user is watching is never what they meant to replace.
 */
function runSelection(): void {
	if (running.value) {
		stop();
		return;
	}
	const id = activeTabId.value;
	if (!id) return;
	const selected = editor?.selection().trim() ?? "";
	if (selected.length > 0) {
		void queryStore.run(id, { sqlOverride: selected });
		return;
	}
	// Already trimmed by the splitter and still carrying its `;`, which is
	// what the backend's own splitter expects to receive.
	const statement = editor?.statementUnderCaret() ?? null;
	if (statement !== null) {
		void queryStore.run(id, { sqlOverride: statement });
		return;
	}
	toggleRun();
}

/* -------------------------------------------------------------------------
 * Datasource picker
 *
 * The Run row is the only chrome that is always on screen while a document is
 * open, so it is where "what does this run against" belongs — a file with no
 * binding used to answer that with a toast telling the user to right-click a
 * row they had no reason to think was interactive.
 * ---------------------------------------------------------------------- */

const sqlFilesStore = useSqlFilesStore();
const { theme } = useTheme();

const datasourceOpen = ref(false);

/**
 * Databases per connection, fetched the first time that connection's submenu
 * is opened and kept for the session. Listing databases is a round trip to the
 * server, so it is not paid for connections the user never looks at.
 */
const databasesByConnection = ref<Record<string, string[]>>({});
const loadingConnections = new Set<string>();

const currentConnection = computed<ConnectionConfig | undefined>(() =>
	connectionsStore.configs.find(
		(entry) => entry.id === activeTab.value?.connectionId,
	),
);

/** The trigger's label: connection and database, or a placeholder. */
const datasourceLabel = computed(() => {
	if (!activeTab.value) return "No connection";
	const name = currentConnection.value?.name ?? "Unknown connection";
	return activeTab.value.database
		? `${name} / ${activeTab.value.database}`
		: name;
});

/**
 * Databases to offer for a connection. The server list is preferred; until it
 * arrives — and for a connection that cannot be reached — the profile's own
 * database and the one the server last reported are still worth offering.
 */
function databasesFor(connection: ConnectionConfig): string[] {
	const listed = databasesByConnection.value[connection.id];
	if (listed) return listed;
	const fallback = new Set([connection.database]);
	const current = connectionsStore.databaseInfo[connection.id]?.currentDatabase;
	if (current) fallback.add(current);
	return [...fallback].filter((name) => name.length > 0);
}

/** True when a (connection, database) pair is what this tab already runs on. */
function isCurrentTarget(
	connection: ConnectionConfig,
	database: string,
): boolean {
	return (
	activeTab.value?.connectionId === connection.id &&
	activeTab.value?.database === database
	);
}

async function loadDatabases(connection: ConnectionConfig): Promise<void> {
	if (
		databasesByConnection.value[connection.id] ||
		loadingConnections.has(connection.id)
	) {
		return;
	}
	loadingConnections.add(connection.id);
	try {
		await connectionsStore.ensureConnected(connection.id);
		const listed = await connectionsStore.listDatabases(connection.id);
		databasesByConnection.value = {
			...databasesByConnection.value,
			[connection.id]: listed.map((entry) => entry.name),
		};
	} catch (err) {
		toast(`${connection.name}: ${errorMessage(err)}`);
	} finally {
		loadingConnections.delete(connection.id);
	}
}

/**
 * The schema a (connection, database) pair should run against.
 *
 * MySQL's schema *is* its database. For Postgres the profile's `defaultSchema`
 * is only right if that schema exists in the database being chosen — a server
 * where `app` has no `public` would otherwise open a tab that fails on its
 * first statement. So the schema list for the target database decides, with
 * `public` as the fallback only when the list is empty or unreachable.
 */
async function schemaFor(
	connection: ConnectionConfig,
	database: string,
): Promise<string> {
	if (connection.dbType === "mysql") return database;
	const preferred = connection.defaultSchema || "public";
	try {
		const schemas = await connectionsStore.listSchemas({
			connectionId: connection.id,
			database,
		});
		if (schemas.includes(preferred)) return preferred;
		return schemas[0] ?? preferred;
	} catch {
		// An unreachable or unreadable database must still be selectable; the
		// server's own error on the first statement is the honest outcome.
		return preferred;
	}
}

/**
 * Points this tab — and, for a file tab, the file itself — at the chosen
 * connection and database.
 */
async function chooseDatasource(
	connection: ConnectionConfig,
	database: string,
): Promise<void> {
	const tab = activeTab.value;
	if (!tab || isCurrentTarget(connection, database)) return;
	const schema = await schemaFor(connection, database);
	// The await above can outlive the menu, and a tab closed in the meantime is
	// no longer the tab this choice was made for.
	if (activeTab.value?.id !== tab.id) return;
	tabsStore.setTarget(tab.id, {
		connectionId: connection.id,
		database,
		schema,
		mode: tab.mode,
		table: tab.table,
	});
	// The binding is what makes the choice survive the tab being closed, and
	// what a bookmark jump or a cold start resolves against.
	if (tab.path) {
		sqlFilesStore.setBinding(tab.path, {
			connectionId: connection.id,
			database,
			schema,
		});
	}
}

/* -------------------------------------------------------------------------
 * Saving
 *
 * A file-backed tab writes itself out 1.5s after the last keystroke. The
 * delay is what makes it autosave rather than a write per character; the
 * optimistic-concurrency token behind `save` is what makes it safe, since a
 * file edited outside the app comes back as a conflict rather than as
 * somebody else's work being overwritten.
 *
 * An untitled query tab has no file to write to, so it never autosaves —
 * `Mod-s` is what turns it into one.
 * ---------------------------------------------------------------------- */

/** How long the document has to be still before it is written to disk. */
const AUTOSAVE_MS = 1500;

/**
 * One pending timer per tab id. Keying by tab rather than by component is
 * what lets a tab switch leave another tab's pending save alone: the text
 * being saved is the text of the tab that earned it.
 */
const pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Tabs whose last write was refused. Autosave stays off for these until the
 * user edits again, so a file that changed on disk is not overwritten by the
 * next keystroke after the warning.
 */
const saveBlocked = new Set<string>();

const saveAsOpen = ref(false);
const saveAsName = ref("");
const saveAsError = ref("");

/**
 * What the SQL watcher last saw: the tab on screen and its text. A change
 * that keeps the tab id is a keystroke; one that changes it is a tab switch,
 * which brings different text with no typing behind it.
 */
let lastEdit: { tabId: string | null; sql: string } = {
	tabId: activeTabId.value,
	sql: activeTab.value?.sql ?? "",
};

/** Drops a tab's pending write, so it cannot race a write the user asked for. */
function cancelPendingSave(tabId: string): void {
	const timer = pendingSaves.get(tabId);
	if (timer === undefined) return;
	clearTimeout(timer);
	pendingSaves.delete(tabId);
}

/**
 * Writes one tab and reports what happened.
 *
 * `save` returns its refusals as data rather than throwing, and each one is
 * an outcome the user has to hear about: the tab stays dirty either way, so
 * the unsaved edits are never dropped on the floor.
 */
async function saveTab(tabId: string): Promise<void> {
	const tab = tabsStore.tabs.find((entry) => entry.id === tabId);
	if (!tab?.path) return;
	try {
		const result = await sqlFilesStore.save(tab.path, tab.sql);
		if (result.ok) {
			saveBlocked.delete(tabId);
			tabsStore.markSaved(tabId);
			return;
		}
		saveBlocked.add(tabId);
		toast(
			result.reason === "conflict"
				? "That file changed on disk — your edits were not written. Save over it from the File menu to replace it."
				: "The file is no longer on disk — it was deleted or moved.",
			8000,
		);
	} catch (err) {
		saveBlocked.add(tabId);
		toast(errorMessage(err));
	}
}

function scheduleSave(tab: Tab): void {
	// A table tab is a read-only view of someone else's data, and a query tab
	// with no path is a scratch buffer: neither has a file to write to.
	if (!tab.path || tab.mode === "table") return;
	cancelPendingSave(tab.id);
	pendingSaves.set(
		tab.id,
		setTimeout(() => {
			pendingSaves.delete(tab.id);
			void saveTab(tab.id);
		}, AUTOSAVE_MS),
	);
}

/**
 * `Mod-s`: writes the file now. A tab with no path has nothing to write, so
 * the same chord asks where the document should live instead.
 */
function saveActiveTab(): boolean {
	const tab = activeTab.value;
	if (!tab || tab.mode === "table") return true;
	cancelPendingSave(tab.id);
	saveBlocked.delete(tab.id);
	if (tab.path) {
		void saveTab(tab.id);
		return true;
	}
	beginSaveAs();
	return true;
}

/** Opens Save As with the tab's own name as the starting point. */
function beginSaveAs(): void {
	const tab = activeTab.value;
	if (!tab) return;
	const folder = sqlFilesStore.folders[0];
	if (!folder) {
		// A new file has to land inside a tree the user has already opened:
		// inventing a location outside one would put it somewhere the Files
		// panel can never show them again.
		toast(
			"Open a folder in the Files panel first — a new file has to go somewhere.",
			6000,
		);
		return;
	}
	saveAsName.value = tab.title.endsWith(".sql")
		? tab.title
		: `${tab.title}.sql`;
	saveAsError.value = "";
	saveAsOpen.value = true;
}

/**
 * Creates the file at the name the user confirmed, then adopts it: the tab
 * takes the path, takes the file's name as its title, and is marked saved.
 * `expectedVersion: null` is "create this, and refuse if something is
 * already there", so Save As can never overwrite a file it never opened.
 */
async function confirmSaveAs(): Promise<void> {
	const tab = activeTab.value;
	const folder = sqlFilesStore.folders[0];
	const name = saveAsName.value.trim();
	if (!tab || !folder || name.length === 0) return;
	// `writeSqlFile` takes a whole path and, unlike the tree's own create
	// operation, does not vet the last segment itself — so a name holding a
	// separator would put the file outside the folder the user picked.
	if (
		name.includes("/") ||
		name.includes("\\") ||
		name === "." ||
		name === ".."
	) {
		saveAsError.value = "A file name cannot contain a path separator.";
		return;
	}
	const path = folder.endsWith("/") ? `${folder}${name}` : `${folder}/${name}`;
	try {
		const result = await rpc.request.writeSqlFile(
			{ path, content: tab.sql, expectedVersion: null },
			{ maxRequestTime: RPC_TIMEOUTS.metadata },
		);
		if (!result.ok) {
			saveAsError.value =
				result.reason === "conflict"
					? "A file with that name already exists."
					: "That file is no longer on disk.";
			return;
		}
		// The file was created behind the store's back, so it holds no version
		// token for this path yet. `read` re-earns one, which is what lets the
		// next autosave be a guarded write rather than a permanent conflict
		// against a file the app itself just created.
		await sqlFilesStore.read(path);
		tab.path = path;
		tabsStore.rename(tab.id, name);
		tabsStore.markSaved(tab.id);
		saveAsError.value = "";
		saveAsOpen.value = false;
		saveBlocked.delete(tab.id);
		// Bookmarks point at a file; this tab now has one, so its gutter is
		// showing the marks of a document that did not exist a moment ago.
		editor?.refreshBookmarks();
		// The new file is not in the scan the tree on screen is showing.
		await sqlFilesStore.refresh(folder);
	} catch (err) {
		saveAsError.value = errorMessage(err);
	}
}

/* -------------------------------------------------------------------------
 * EditorView lifecycle
 *
 * The view and its compartments live in the closure created by `mountEditor`;
 * only a small typed control surface escapes, so no CodeMirror symbol has to
 * be named outside the dynamically imported modules.
 * ---------------------------------------------------------------------- */

interface EditorHandle {
	/** Replaces the whole document with another tab's SQL. */
	swapTo(tabId: string, sql: string): void;
	/** Re-points the language compartment at a database type. */
	setLanguage(next: DatabaseType): void;
	/** Re-points the theme compartment at the light or dark defaults. */
	setTheme(dark: boolean): void;
	/** Flips the read-only compartment. */
	setReadOnly(next: boolean): void;
	/** Moves the caret to a one-based line and scrolls it to the middle. */
	goToLine(line: number): void;
	/** The one-based line the caret is on. */
	currentLine(): number;
	/** The text of a one-based line, which is what a bookmark is digested from. */
	lineText(line: number): string;
	/**
	 * The selected text, or an empty string when the selection is
	 * empty/cursor-only. This is the only way out of the closure for the
	 * selection itself: the `EditorView` never escapes it.
	 */
	selection(): string;
	/**
	 * The text of the statement the caret is inside, or `null` when the caret
	 * is in none — the blank space between two statements, or an empty
	 * document. Read from the caret's head rather than the selection: a
	 * selection is an instruction to run a range, an outline is not, and the
	 * two disagree the moment a selection spans a statement boundary.
	 */
	statementUnderCaret(): string | null;
	/** Redraws the bookmark gutter after the store changed. */
	refreshBookmarks(): void;
	/** Tears the view down; its element goes away with the component. */
	destroy(): void;
}

let editor: EditorHandle | null = null;

async function mountEditor(): Promise<void> {
	const container = host.value;
	if (!container || editor) return;
	const cm = await loadRuntime();
	// The component may have unmounted while the chunk was in flight.
	if (!host.value || editor) return;

	const {
		view: V,
		state: S,
		commands,
		search,
		langSql,
		language,
		autocomplete,
		oneDark,
		dialect,
	} = cm;

	/** Marks a transaction as a tab swap, so it is not written back to the store. */
	const externalSwap = S.Annotation.define<boolean>();

	/** Carries the tab a freshly swapped document belongs to. */
	const setDocTab = S.StateEffect.define<{ tabId: string; sql: string }>();

	/** Which tab the visible document belongs to; the single source of truth. */
	const docTab = S.StateField.define<string | null>({
		create: () => null,
		update: (value, transaction) => {
			for (const effect of transaction.effects) {
				if (effect.is(setDocTab)) return effect.value.tabId;
			}
			return value;
		},
	});

	/** Asks the gutter to rebuild itself after the bookmarks store changed. */
	const redrawBookmarks = S.StateEffect.define<null>();

	/**
	 * The mnemonic glyph, drawn in the gutter beside the line it points at. A
	 * `GutterMarker` rather than a bare element so CodeMirror can compare marks
	 * and redraw only what moved.
	 */
	class BookmarkGlyph extends V.GutterMarker {
		constructor(readonly glyph: string) {
			super();
		}

		override eq(other: CmView.GutterMarker): boolean {
			return other instanceof BookmarkGlyph && other.glyph === this.glyph;
		}

		override toDOM(): HTMLElement {
			const span = document.createElement("span");
			span.className = "cm-bookmark-glyph";
			span.textContent = this.glyph;
			return span;
		}
	}

	/** Bookmarks for the file on screen, keyed by line. */
	function bookmarkMarks(
		state: CmState.EditorState,
	): CmState.RangeSet<CmView.GutterMarker> {
		const tabId = state.field(docTab);
		const tab = tabsStore.tabs.find((entry) => entry.id === tabId);
		const marks = bookmarksStore.forPath(tab?.path);
		if (marks.size === 0) return S.RangeSet.empty;
		const builder = new S.RangeSetBuilder<CmView.GutterMarker>();
		for (const [line, mnemonic] of marks) {
			if (line < 1 || line > state.doc.lines) continue;
			const at = state.doc.line(line).from;
			builder.add(at, at, new BookmarkGlyph(mnemonic));
		}
		return builder.finish();
	}

	const bookmarkGutter = S.StateField.define<
		CmState.RangeSet<CmView.GutterMarker>
	>({
		create: (state) => bookmarkMarks(state),
		update: (marks, transaction) => {
			const changed =
				transaction.docChanged ||
				transaction.effects.some(
					(effect) => effect.is(redrawBookmarks) || effect.is(setDocTab),
				);
			return changed
				? bookmarkMarks(transaction.state)
				: marks.map(transaction.changes);
		},
		provide: (field) =>
			V.gutter({
				class: "cm-bookmark-gutter",
				markers: (view) => view.state.field(field),
			}),
	});

	/** The statement under the caret, as the range its outline is drawn over. */
	interface OutlineRange {
		/** Offset of the statement's first character. */
		from: number;
		/** Offset just past the statement's last character. */
		to: number;
	}

	/** The box a statement's outline occupies, in layer-marker pixels. */
	interface OutlineRect {
		left: number;
		top: number;
		width: number;
		height: number;
	}

	/**
	 * Breathing room between the statement's text and the outline's border.
	 * Without it the 1px border is centred on the first and last glyphs and
	 * shaves a column off them.
	 */
	const OUTLINE_INSET_PX = 1;

	/**
	 * The statement under the caret, as the range the outline box spans.
	 *
	 * Kept as a range rather than as coordinates because coordinates are a
	 * question only a laid-out view can answer: the field is what the box is
	 * drawn *from*, and it stays correct across the transactions that move the
	 * text out from under an already-computed rectangle.
	 */
	function outlineStatement(state: CmState.EditorState): OutlineRange | null {
		const statement = statementAt(
			state.doc.toString(),
			state.selection.main.head,
		);
		if (!statement) return null;
		return { from: statement.start, to: statement.end };
	}

	/**
	 * Last non-blank character offset in `[from, to)`, or `null` when the
	 * slice holds nothing but whitespace.
	 */
	function lastContentOffset(
		doc: CmState.Text,
		from: number,
		to: number,
	): number | null {
		const content = doc.sliceString(from, to).trimEnd();
		return content.length ? from + content.length - 1 : null;
	}

	/**
	 * Pixel rectangle of the outline box around `[from, to)`, in the document
	 * coordinates a layer marker is positioned in. `null` when the statement
	 * is not rendered at all.
	 *
	 * The left edge is the statement's own first character, so an indented
	 * statement is boxed at its indentation rather than at the editor's
	 * margin; the right edge is the last non-blank character of the *widest*
	 * line, because a short closing line must not stretch the box out to the
	 * edge of the editor.
	 *
	 * Both edges are measured line by line rather than from the statement's two
	 * ends, and that is the whole reason this is geometry and not a
	 * decoration: a mark spans one line and a line decoration spans the
	 * editor's full width, and neither of them can say "stop where the text
	 * stops".
	 */
	function statementOutlineRect(
		view: CmView.EditorView,
		from: number,
		to: number,
	): OutlineRect | null {
		const doc = view.state.doc;
		// A range that holds nothing has no rightmost character to look for,
		// and `to - 1` would reach back into whatever precedes it.
		if (to <= from) return null;
		// `to` sits just past the statement's last character, so the line the
		// statement ends on is the one holding `to - 1`.
		const firstLine = doc.lineAt(from);
		const lastLine = doc.lineAt(to - 1);
		// Layer markers are positioned relative to the document while
		// `coordsAtPos` reports viewport coordinates, so undo the scroller's
		// own offset and its scroll position to get from one to the other.
		const base = view.scrollDOM.getBoundingClientRect();
		const layerX = (x: number) =>
			(x - base.left) / view.scaleX + view.scrollDOM.scrollLeft;
		const layerY = (y: number) =>
			(y - base.top) / view.scaleY + view.scrollDOM.scrollTop;

		// A line scrolled out of the viewport has no coordinates;
		// `lineBlockAt` measures from the document's own height map and always
		// has an answer. Its coordinates start at `documentTop` — the first
		// line's top, *not* the top of the padded content box the layer's
		// origin sits at — so the content padding has to be added back or the
		// box jumps by that much the moment a line leaves the viewport.
		const paddingTop = view.documentPadding.top;
		const startCoords = view.coordsAtPos(from, 1);
		const endCoords = view.coordsAtPos(to - 1, 1);
		const top = startCoords
			? layerY(startCoords.top)
			: view.lineBlockAt(from).top + paddingTop;
		const bottom = endCoords
			? layerY(endCoords.bottom)
			: view.lineBlockAt(to - 1).bottom + paddingTop;
		if (bottom - top <= 0) return null;

		// The left edge belongs to the statement's *first* character and to
		// nothing else. Taking the minimum across every line would drag it out
		// to the editor margin as soon as one continuation line was less
		// indented than the statement's opening one, which is exactly the
		// thing the outline is supposed to show. So it is read off the first
		// line alone and the rest of the loop never touches it.
		let left = Infinity;
		let right = -Infinity;
		let wraps = false;
		for (let number = firstLine.number; number <= lastLine.number; number++) {
			const line = doc.line(number);
			const lineFrom = Math.max(line.from, from);
			const lineTo = Math.min(line.to, to);
			const lineStart = view.coordsAtPos(lineFrom, 1);
			// Off-viewport lines contribute nothing: they are not laid out, so
			// they have no rightmost character to report.
			if (!lineStart) continue;
			if (number === firstLine.number) left = lineStart.left;
			// A blank line inside the statement contributes only its start x.
			const content = lastContentOffset(doc, lineFrom, lineTo);
			const lineEnd =
				content === null ? lineStart : view.coordsAtPos(content, 1);
			if (!lineEnd) continue;
			right = Math.max(right, lineEnd.right);
			// A soft-wrapped line keeps filling the content width on its
			// intermediate visual rows even when its last one is short, so the
			// statement's right edge is the content edge, not its last glyph.
			// Only the right edge moves: the left stays on the opening
			// character, wrap or no wrap.
			if (Math.abs(lineEnd.top - lineStart.top) > 1) wraps = true;
		}
		if (!isFinite(left) || !isFinite(right)) return null;
		if (wraps) {
			right = Math.max(
				right,
				view.contentDOM.getBoundingClientRect().right,
			);
		}

		return {
			left: layerX(left) - OUTLINE_INSET_PX,
			top: top - OUTLINE_INSET_PX,
			width: right - left + OUTLINE_INSET_PX * 2,
			height: bottom - top + OUTLINE_INSET_PX * 2,
		};
	}

	/**
	 * The statement the caret is inside, outlined.
	 *
	 * Recomputed from the caret's *head* rather than the whole selection
	 * range: the outline answers "what would `Mod-Enter` run right now", and a
	 * selection spanning two statements has no single answer — the run would
	 * be the selection, not either statement. Outlining the head keeps the box
	 * and the chord telling the same story, which is the only way a user can
	 * trust either of them.
	 *
	 * A tab swap is a document replacement that happens to keep its own
	 * transaction shape, so `setDocTab` is watched alongside `docChanged`:
	 * without it the previous tab's outline would stay on screen over the new
	 * document until the next keystroke.
	 */
	const statementOutline = S.StateField.define<OutlineRange | null>({
		create: (state) => outlineStatement(state),
		update: (range, transaction) => {
			const changed =
				transaction.docChanged ||
				transaction.selection ||
				transaction.effects.some((effect) => effect.is(setDocTab));
			return changed ? outlineStatement(transaction.state) : range;
		},
	});

	/**
	 * The outline box itself, drawn as one layer marker.
	 *
	 * A `layer` rather than a decoration for the reason given on
	 * `statementOutlineRect`: the shape cannot be expressed as a mark or a
	 * line class. It also has to sit *above* the content so the active-line
	 * tint cannot paint over the border, which is why the box carries
	 * `pointer-events: none` — otherwise it would swallow every click inside
	 * itself, including the ones that place the caret.
	 */
	const statementOutlineLayer = V.layer({
		above: true,
		class: "cm-statement-outline",
		update(update: CmView.ViewUpdate): boolean {
			// The box is positioned in document coordinates, so scrolling
			// cannot move it — but a scroll that brings previously unmeasured
			// lines into view can change how wide the box has to be.
			if (update.viewportChanged || update.geometryChanged) return true;
			if (
				update.transactions.some((transaction) =>
					transaction.effects.some((effect) => effect.is(setDocTab)),
				)
			)
				return true;
			const before = update.startState.field(statementOutline);
			const after = update.state.field(statementOutline);
			if (!before || !after) return before !== after;
			return before.from !== after.from || before.to !== after.to;
		},
		markers(view: CmView.EditorView): readonly CmView.LayerMarker[] {
			const outline = view.state.field(statementOutline);
			if (!outline) return [];
			const rect = statementOutlineRect(view, outline.from, outline.to);
			if (!rect) return [];
			return [
				new V.RectangleMarker(
					"cm-statement-box",
					rect.left,
					rect.top,
					rect.width,
					rect.height,
				),
			];
		},
	});

	const languageCompartment = new S.Compartment();
	const readOnlyCompartment = new S.Compartment();
	/**
	 * CodeMirror picks its own defaults for light or dark from this flag, so it
	 * has to follow the app theme rather than being pinned at mount.
	 */
	const themeCompartment = new S.Compartment();
	const sqlLanguage = (type: DatabaseType) =>
		langSql.sql({ dialect: dialect.codeMirrorSqlDialect(type) });

	const readOnlyConfig = (locked: boolean) => [
		S.EditorState.readOnly.of(locked),
		V.EditorView.editable.of(!locked),
	];

	// Colours come from the token palette globals.css already defines.
	const editorTheme = (dark: boolean) =>
		V.EditorView.theme(
			{
				"&": {
					backgroundColor: "var(--background)",
					color: "var(--foreground)",
					height: "100%",
				},
				".cm-content": {
					caretColor: "var(--foreground)",
					padding: "8px 0",
				},
				".cm-cursor, .cm-dropCursor": {
					borderLeftColor: "var(--foreground)",
				},
				".cm-gutters": {
					backgroundColor: "var(--background)",
					color: "var(--muted-foreground)",
					borderRight: "1px solid var(--border)",
				},
				".cm-activeLine": {
					backgroundColor:
						"color-mix(in srgb, var(--accent) 40%, transparent)",
				},
				".cm-activeLineGutter": {
					backgroundColor:
						"color-mix(in srgb, var(--accent) 40%, transparent)",
				},
				// The statement outline: one rounded rectangle drawn by
				// `statementOutlineLayer`, sized to the statement's text
				// rather than to the editor. The fill stays a hint — strong
				// enough to find at a glance, weak enough not to fight the
				// selection and the active-line tint it sits on top of — and
				// the border carries the read. `--primary` is near-black in
				// light and near-white in dark, so the same mixes read on
				// both without a second token.
				".cm-statement-box": {
					pointerEvents: "none",
					border: "1px solid color-mix(in srgb, var(--primary) 55%, transparent)",
					borderRadius: "5px",
					backgroundColor:
						"color-mix(in srgb, var(--primary) 7%, transparent)",
				},
				".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
					backgroundColor:
						"color-mix(in srgb, var(--primary) 20%, transparent)",
				},
				".cm-selectionMatch": {
					backgroundColor: "color-mix(in srgb, var(--ring) 30%, transparent)",
				},
				".cm-searchMatch": {
					backgroundColor: "color-mix(in srgb, var(--warning) 35%, transparent)",
				},
				".cm-panels": {
					backgroundColor: "var(--chrome)",
					color: "var(--foreground)",
				},
			},
			{ dark },
		);

	/**
	 * Token palette: One Dark's, not the shell's. The UI tokens deliberately
	 * spend one accent across several roles, which is why every token used to
	 * come out the same shade; One Dark gives each class its own colour, and
	 * the mid-tone values it picks stay legible on a light background too.
	 *
	 * Only the palette is taken. The editor chrome — background, gutters,
	 * selection — stays on the app's own tokens below, so the editor follows
	 * the shell's light/dark switch instead of being dark in both.
	 */
	const highlight = language.syntaxHighlighting(oneDark.oneDarkHighlightStyle);

	const initialTab = tabsStore.activeTab;

	const editorView = new V.EditorView({
		parent: container,
		state: S.EditorState.create({
			doc: initialTab?.sql ?? "",
			extensions: [
				docTab,
				languageCompartment.of(sqlLanguage(dbType.value)),
				readOnlyCompartment.of(readOnlyConfig(readOnly.value)),
				themeCompartment.of(editorTheme(theme.value === "dark")),
				highlight,
				V.lineNumbers(),
				bookmarkGutter,
				statementOutline,
				statementOutlineLayer,
				// Assigning is a DOM event, registered ahead of the keymap:
				// preventing the default is what stops `Ctrl-Shift-a` from also
				// jumping to `a`.
				S.Prec.highest(
					V.EditorView.domEventHandlers({ keydown: assignFromShortcut }),
				),
				S.Prec.highest(V.keymap.of(bookmarkBindings())),
				V.highlightActiveLine(),
				V.highlightActiveLineGutter(),
				V.drawSelection(),
				V.dropCursor(),
				V.rectangularSelection(),
				V.EditorView.lineWrapping,
				commands.history(),
				language.indentOnInput(),
				language.bracketMatching(),
				autocomplete.closeBrackets(),
				V.keymap.of(autocomplete.closeBracketsKeymap),
				// Snippets are offered by prefix and never expand on their own:
				// the user picks an entry from the popup, and only then does
				// `snippetCompletion` own the `${n}` tab-stop session.
				autocomplete.autocompletion({
					override: [
						snippetCompletionSource(
							() => snippetsStore.enabledSnippets,
							autocomplete.snippetCompletion,
						),
					],
				}),
				search.search({ top: true }),
				search.highlightSelectionMatches(),
				V.EditorView.updateListener.of((update) => {
					if (!update.docChanged) return;
					// A tab swap changes the document too; it is not a user edit.
					if (update.transactions.some((tr) => tr.annotation(externalSwap))) {
						return;
					}
					const tabId = update.state.field(docTab);
					if (!tabId) return;
					const tab = tabsStore.tabs.find((entry) => entry.id === tabId);
					if (tab) tab.sql = update.state.doc.toString();
				}),
				V.keymap.of([
					{
						key: "Mod-Enter",
						preventDefault: true,
						run: () => {
							runSelection();
							return true;
						},
					},
					{
						key: "Mod-s",
						preventDefault: true,
						run: () => saveActiveTab(),
					},
					...commands.defaultKeymap,
					...search.searchKeymap,
					...commands.historyKeymap,
					commands.indentWithTab,
				]),
			],
		}),
	});

	editor = {
		swapTo(tabId: string, sql: string) {
			if (editorView.state.field(docTab) === tabId) return;
			editorView.dispatch({
				changes: { from: 0, to: editorView.state.doc.length, insert: sql },
				effects: setDocTab.of({ tabId, sql }),
				annotations: [externalSwap.of(true)],
			});
			editorView.focus();
		},
		setLanguage(next: DatabaseType) {
			editorView.dispatch({
				effects: languageCompartment.reconfigure(sqlLanguage(next)),
			});
		},
		setTheme(dark: boolean) {
			editorView.dispatch({
				effects: themeCompartment.reconfigure(editorTheme(dark)),
			});
		},
		setReadOnly(next: boolean) {
			editorView.dispatch({
				effects: readOnlyCompartment.reconfigure(readOnlyConfig(next)),
			});
		},
		goToLine(line: number) {
			const target = editorView.state.doc.line(
				Math.min(Math.max(line, 1), editorView.state.doc.lines),
			);
			editorView.dispatch({
				selection: { anchor: target.from },
				effects: V.EditorView.scrollIntoView(target.from, { y: "center" }),
			});
			editorView.focus();
		},
		currentLine() {
			return editorView.state.doc.lineAt(editorView.state.selection.main.head).number;
		},
		lineText(line: number) {
			const doc = editorView.state.doc;
			return doc.line(Math.min(Math.max(line, 1), doc.lines)).text;
		},
		selection() {
			// The main range is the selection every ordinary interaction makes.
			// A cursor is an empty range, and an empty string is what the caller
			// reads as "run the whole document".
			const main = editorView.state.selection.main;
			return main.empty ? "" : editorView.state.sliceDoc(main.from, main.to);
		},
		statementUnderCaret() {
			// The same answer the outline is drawn from, so the box on screen and
			// the text `Mod-Enter` hands the backend cannot drift apart.
			const state = editorView.state;
			return (
				statementAt(
					state.doc.toString(),
					state.selection.main.head,
				)?.sql ?? null
			);
		},
		refreshBookmarks() {
			editorView.dispatch({ effects: redrawBookmarks.of(null) });
		},
		destroy() {
			editorView.destroy();
		},
	};

	editorReady.value = true;

	if (initialTab) {
		editorView.dispatch({
			effects: setDocTab.of({ tabId: initialTab.id, sql: initialTab.sql }),
			annotations: [externalSwap.of(true)],
		});
		// A watcher never fires for a value that was already there when the
		// component mounted, and a jump from outside the editor is exactly
		// that: the window handler ran while no query tab was open, opened
		// this one, and left a pending jump naming it. The document is
		// installed by hand just above, so the caret has to be placed by hand
		// too — otherwise the right tab appears and the line does not. A jump
		// naming some other tab is left alone; the watcher further down picks
		// it up when that tab activates.
		const jump = bookmarksStore.pendingJump;
		if (jump?.tabId === initialTab.id) {
			editor.goToLine(jump.line);
			bookmarksStore.pendingJump = null;
		}
		editorView.focus();
	}
}

onMounted(() => {
	void mountEditor();
	window.addEventListener("keydown", onWindowSave);
});

/**
 * `Mod-s` for the whole window, not just the editor.
 *
 * A CodeMirror keymap only sees a key when the editor holds focus, so saving
 * from the file tree, a dialog or the tab strip would otherwise do nothing at
 * all. The editor's own binding handles the focused case first and calls
 * `preventDefault`; this only catches the rest. Typing into a text field is
 * left alone — an input is somewhere the user is typing a name, not somewhere
 * they are asking the app to write a file.
 */
function onWindowSave(event: KeyboardEvent): void {
	if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
	if (event.key !== "s" && event.key !== "S") return;
	if (event.defaultPrevented) return;
	const target = event.target;
	if (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA")
	) {
		return;
	}
	if (!activeTab.value || activeTab.value.mode === "table") return;
	event.preventDefault();
	saveActiveTab();
}

onBeforeUnmount(() => {
	// A pending autosave outliving the component would write through a store
	// the window is tearing down, and so would the window listener.
	for (const timer of pendingSaves.values()) clearTimeout(timer);
	pendingSaves.clear();
	window.removeEventListener("keydown", onWindowSave);
	editor?.destroy();
	editor = null;
	editorReady.value = false;
});

/* -------------------------------------------------------------------------
 * Store <-> editor binding
 * ---------------------------------------------------------------------- */

// The document already belongs to this tab — nothing to do on first mount.
watch(activeTabId, (tabId) => {
	if (!tabId || !editor) return;
	const tab = tabsStore.tabs.find((entry) => entry.id === tabId);
	editor.swapTo(tabId, tab?.sql ?? "");
	// A jump that named this tab has just brought it on screen; its line is
	// resolved against the document the swap installed.
	const jump = bookmarksStore.pendingJump;
	if (jump?.tabId === tabId) {
		editor.goToLine(jump.line);
		bookmarksStore.pendingJump = null;
	}
});

watch(dbType, (next) => {
	editor?.setLanguage(next);
});

watch(readOnly, (next) => {
	editor?.setReadOnly(next);
});

watch(theme, (next) => {
	editor?.setTheme(next === "dark");
});

/**
 * A jump is announced by the bookmarks store once its file is on screen. The
 * editor applies it here, because only it knows where the caret is and what the
 * document looks like now.
 */
watch(
	() => bookmarksStore.pendingJump,
	(jump) => {
		if (jump && jump.tabId === activeTabId.value) {
			editor?.goToLine(jump.line);
			bookmarksStore.pendingJump = null;
		}
	},
);

/** Redraws the gutter when a bookmark is added, moved or removed. */
watch(
	() => bookmarksStore.rows,
	() => editor?.refreshBookmarks(),
	{ deep: true },
);

/**
 * Autosave. `docChanged` has already written the new text back to `tab.sql`,
 * so the store's copy of the active tab is the single source of what is on
 * screen — there is no second write path here.
 *
 * The tab id is watched alongside the SQL because a tab switch changes the
 * text on screen without anything having been typed: only a change that
 * leaves the tab id alone is a keystroke, and whatever the tab being left
 * behind owed its file is already sitting in its own timer.
 */
watch(
	() => [activeTabId.value, activeTab.value?.sql ?? ""] as const,
	(next) => {
		const [tabId, sql] = next;
		const edited = tabId !== null && tabId === lastEdit.tabId;
		lastEdit = { tabId, sql };
		if (!edited) return;
		// A refusal turned autosave off for this tab; the keystroke after it
		// is the user deciding to try again, and the one after that writes.
		if (saveBlocked.has(tabId)) {
			saveBlocked.delete(tabId);
			return;
		}
		const tab = tabsStore.tabs.find((entry) => entry.id === tabId);
		if (tab) scheduleSave(tab);
	},
);
</script>

<template>
	<div class="flex h-full min-h-0 flex-1 flex-col" data-slot="sql-editor">
		<div
			class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-chrome px-2"
		>
			<Button
				v-if="running"
				variant="destructive"
				size="sm"
				aria-label="Stop query"
				@click="stop"
			>
				<SquareIcon aria-hidden="true" />
				Stop
			</Button>
			<Button
				v-else
				variant="default"
				size="sm"
				aria-label="Run query"
				:disabled="!activeTabId || statementCount === 0"
				@click="run"
			>
				<PlayIcon aria-hidden="true" />
				Run
			</Button>
			<span class="text-[11px] text-muted-foreground">
				{{ statementCount }} statement{{ statementCount === 1 ? "" : "s" }}
			</span>

			<!-- Datasource: which connection and database this document runs
			     against, and where that choice is changed. It sits on the right
			     because it belongs to the document, not to the statement bar. -->
			<DropdownMenu v-if="connectionsStore.configs.length > 0" v-model:open="datasourceOpen">
				<DropdownMenuTrigger as-child>
					<Button
						variant="ghost"
						size="sm"
						class="ml-auto h-6 gap-1 px-2 text-[11px] font-normal text-muted-foreground hover:text-foreground"
						:aria-label="`Datasource: ${datasourceLabel}. Change`"
					>
						<Database aria-hidden="true" />
						<span class="max-w-64 truncate">{{ datasourceLabel }}</span>
						<ChevronDown aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" class="w-64">
					<DropdownMenuLabel>Run against</DropdownMenuLabel>
					<div class="max-h-[min(60vh,24rem)] overflow-y-auto overscroll-contain">
						<DropdownMenuSub
							v-for="connection in connectionsStore.configs"
							:key="connection.id"
						>
							<DropdownMenuSubTrigger
								:class="{
									'font-semibold': connection.id === activeTab?.connectionId,
								}"
								@pointerenter="loadDatabases(connection)"
							>
								{{ connection.name }}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								<div class="max-h-[min(50vh,20rem)] overflow-y-auto overscroll-contain">
									<DropdownMenuItem
										v-for="database in databasesFor(connection)"
										:key="database"
										:data-current="isCurrentTarget(connection, database) ? 'true' : undefined"
										class="gap-2"
										@select="chooseDatasource(connection, database)"
									>
										<Check
											aria-hidden="true"
											class="size-3 shrink-0"
											:class="isCurrentTarget(connection, database) ? '' : 'invisible'"
										/>
										<span class="truncate">{{ database }}</span>
									</DropdownMenuItem>
									<DropdownMenuItem v-if="databasesFor(connection).length === 0" disabled>
										No databases
									</DropdownMenuItem>
								</div>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					</div>
					<DropdownMenuSeparator />
					<p class="px-2 py-1 text-[11px] text-muted-foreground">
						{{ activeTab?.path ? "Saved with this file" : "This tab only" }}
					</p>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
		<div class="relative min-h-0 flex-1 overflow-hidden">
			<div ref="host" class="h-full" />
			<p
				v-if="!editorReady"
				class="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground"
			>
				Loading editor…
			</p>
		</div>

		<!-- Save As: a tab with no path has no file yet, and `Mod-s` is the
		     chord that asks for one. The name is the only thing being decided
		     here — the folder is the first one already open in the Files
		     panel, so the file lands somewhere the user can see it. -->
		<Dialog v-model:open="saveAsOpen">
			<DialogContent class="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Save SQL as</DialogTitle>
					<DialogDescription>
						Writes this query to a new file in the first folder open in
						the Files panel.
					</DialogDescription>
				</DialogHeader>
				<Input
					:model-value="saveAsName"
					spellcheck="false"
					autocomplete="off"
					aria-label="File name"
					@update:model-value="saveAsName = String($event)"
					@keydown.enter="confirmSaveAs"
				/>
				<p
					v-if="saveAsError"
					class="text-xs text-destructive"
					role="alert"
				>
					{{ saveAsError }}
				</p>
				<DialogFooter>
					<Button variant="ghost" @click="saveAsOpen = false">Cancel</Button>
					<Button
						variant="default"
						:disabled="saveAsName.trim().length === 0"
						@click="confirmSaveAs"
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	</div>
</template>
