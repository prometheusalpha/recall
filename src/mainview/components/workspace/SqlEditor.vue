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
import { useSnippetsStore } from "../../stores/snippets";
import { useBookmarksStore } from "../../stores/bookmarks";
import { useSqlFilesStore } from "../../stores/sqlFiles";
import { useTheme } from "../../composables/useTheme";
import { splitSqlStatements } from "../../lib/sqlSplit";
import { errorMessage } from "../../lib/rpc";
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

function jumpTo(mnemonic: string): boolean {
	void bookmarksStore.jump(mnemonic);
	return true;
}

/**
 * The keymap bookmarks need. Jumping is `Ctrl-<character>`; assigning is
 * `Ctrl-Shift-<character>` (handled as a DOM event below) or `Ctrl-F11`
 * followed by one of the 36 characters.
 */
function bookmarkBindings(): CmView.KeyBinding[] {
	const bindings: CmView.KeyBinding[] = [
		{ key: "Ctrl-F11", preventDefault: true, run: () => beginAssign() },
		{ key: "Escape", run: () => cancelAssign() },
	];
	for (const mnemonic of MNEMONICS) {
		bindings.push({ key: `Ctrl-${mnemonic}`, run: () => jumpTo(mnemonic) });
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
 * is what keeps the keymap below from also treating the press as a jump.
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
							toggleRun();
							return true;
						},
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
		editorView.focus();
	}
}

onMounted(() => {
	void mountEditor();
});

onBeforeUnmount(() => {
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
						</DropdownMenuSubContent>
					</DropdownMenuSub>
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
	</div>
</template>
