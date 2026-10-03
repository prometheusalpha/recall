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
import { PlayIcon, SquareIcon } from "lucide-vue-next";
import { useConnectionsStore } from "../../stores/connections";
import { useQueryStore } from "../../stores/query";
import { useTabsStore } from "../../stores/tabs";
import { useSnippetsStore } from "../../stores/snippets";
import { splitSqlStatements } from "../../lib/sqlSplit";
import type { DatabaseType } from "../../../shared/types";
import type * as CmView from "@codemirror/view";
import type * as CmState from "@codemirror/state";
import type * as CmCommands from "@codemirror/commands";
import type * as CmSearch from "@codemirror/search";
import type * as CmLangSql from "@codemirror/lang-sql";
import type * as CmLanguage from "@codemirror/language";
import type * as LezerHighlight from "@lezer/highlight";
import type * as CmAutocomplete from "@codemirror/autocomplete";
import type * as SqlDialectModule from "../../lib/sqlDialect";
import { Button } from "../ui/button";
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
	 * `tags` lives in `@lezer/highlight`, and `closeBrackets` belongs to
	 * `@codemirror/autocomplete` — neither is re-exported by
	 * `@codemirror/language`, so each comes from its own package.
	 */
	highlight: typeof LezerHighlight;
	autocomplete: typeof CmAutocomplete;
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
		import("@lezer/highlight"),
		import("@codemirror/autocomplete"),
		import("../../lib/sqlDialect"),
	]).then(
		([
			view,
			state,
			commands,
			search,
			langSql,
			language,
			highlight,
			autocomplete,
			dialect,
		]) => ({
			view,
			state,
			commands,
			search,
			langSql,
			language,
			highlight,
			autocomplete,
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
	/** Flips the read-only compartment. */
	setReadOnly(next: boolean): void;
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
		highlight: lezerHighlight,
		autocomplete,
		dialect,
	} = cm;
	const { tags } = lezerHighlight;

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

	const languageCompartment = new S.Compartment();
	const readOnlyCompartment = new S.Compartment();

	const sqlLanguage = (type: DatabaseType) =>
		langSql.sql({ dialect: dialect.codeMirrorSqlDialect(type) });

	const readOnlyConfig = (locked: boolean) => [
		S.EditorState.readOnly.of(locked),
		V.EditorView.editable.of(!locked),
	];

	// Colours come from the token palette globals.css already defines.
	const theme = V.EditorView.theme(
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
			".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
			".cm-gutters": {
				backgroundColor: "var(--background)",
				color: "var(--muted-foreground)",
				borderRight: "1px solid var(--border)",
			},
			".cm-activeLine": {
				backgroundColor: "color-mix(in srgb, var(--accent) 40%, transparent)",
			},
			".cm-activeLineGutter": {
				backgroundColor: "color-mix(in srgb, var(--accent) 40%, transparent)",
			},
			".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
				backgroundColor: "color-mix(in srgb, var(--primary) 20%, transparent)",
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
		{ dark: true },
	);

	// globals.css covers the `.cm-*` chrome; only token classes are ours.
	const highlight = language.syntaxHighlighting(
		language.HighlightStyle.define([
			{
				tag: tags.keyword,
				color: "var(--foreground)",
				fontWeight: "600",
			},
			{
				tag: [tags.comment, tags.meta],
				color: "var(--muted-foreground)",
				fontStyle: "italic",
			},
			{ tag: tags.string, color: "var(--success)" },
			{
				tag: [tags.number, tags.bool, tags.null, tags.atom],
				color: "var(--warning)",
			},
			{
				tag: [
					tags.typeName,
					tags.className,
					tags.namespace,
					tags.propertyName,
					tags.attributeName,
					tags.definition(tags.variableName),
				],
				color: "var(--foreground)",
			},
			{
				tag: [tags.function(tags.variableName), tags.labelName],
				color: "var(--foreground)",
			},
			{
				tag: [
					tags.operator,
					tags.operatorKeyword,
					tags.punctuation,
					tags.separator,
					tags.bracket,
					tags.angleBracket,
				],
				color: "var(--muted-foreground)",
			},
			{ tag: tags.invalid, color: "var(--destructive)" },
		]),
	);

	const initialTab = tabsStore.activeTab;

	const editorView = new V.EditorView({
		parent: container,
		state: S.EditorState.create({
			doc: initialTab?.sql ?? "",
			extensions: [
				docTab,
				languageCompartment.of(sqlLanguage(dbType.value)),
				readOnlyCompartment.of(readOnlyConfig(readOnly.value)),
				theme,
				highlight,
				V.lineNumbers(),
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
		setReadOnly(next: boolean) {
			editorView.dispatch({
				effects: readOnlyCompartment.reconfigure(readOnlyConfig(next)),
			});
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
});

watch(dbType, (next) => {
	editor?.setLanguage(next);
});

watch(readOnly, (next) => {
	editor?.setReadOnly(next);
});
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
