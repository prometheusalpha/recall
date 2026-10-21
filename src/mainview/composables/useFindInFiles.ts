/**
 * Find in Files: the modal's state and its two actions, search and open.
 *
 * Module-level like `useQuickOpen`: the window shell (Cmd/Ctrl+Shift+F) and the
 * dialog share `open` and `query` without sharing a component. Unlike the
 * palette, the query and toggles survive a close, as JetBrains' popup does:
 * reopening is usually "look again for the same thing".
 */
import { ref, watch } from "vue";
import type { FindInFilesMatch } from "../../shared/findInFiles";
import { useBookmarksStore } from "../stores/bookmarks";
import { useConnectionsStore } from "../stores/connections";
import { useSqlFilesStore } from "../stores/sqlFiles";
import { useTabsStore } from "../stores/tabs";
import { resolveFileDatasource } from "../lib/fileDatasource";
import { errorMessage, rpc, RPC_TIMEOUTS } from "../lib/rpc";
import { toast } from "./useToast";

/** One ripgrep run per pause in typing; the backend kills a run a newer one replaces. */
const SEARCH_DEBOUNCE_MS = 200;

const open = ref(false);
const query = ref("");
const caseSensitive = ref(false);
const wholeWord = ref(false);
const regex = ref(false);
/** Null until the first open, which seeds it from the file tree's own filter. */
const mask = ref<string | null>(null);

const rows = ref<FindInFilesMatch[]>([]);
const truncated = ref(false);
const error = ref<string | null>(null);
const searching = ref(false);

let searchTimer: number | undefined;
/** Drops a response for a query the user has already typed past. */
let generation = 0;
let watching = false;

/**
 * Text selected in the editor, as the initial query. Read from the DOM
 * selection because CodeMirror mirrors its own into it while focused, and the
 * shortcut fires from the window with no handle on the editor. Multi-line
 * selections are ignored, as JetBrains does.
 */
function editorSelection(): string {
	const active = document.activeElement;
	if (!active?.closest(".cm-editor")) return "";
	const text = document.getSelection()?.toString() ?? "";
	return text.includes("\n") ? "" : text;
}

export function useFindInFiles() {
	const sqlFiles = useSqlFilesStore();
	const connections = useConnectionsStore();
	const tabs = useTabsStore();
	const bookmarks = useBookmarksStore();

	async function search(): Promise<void> {
		const ticket = ++generation;
		const text = query.value;
		if (!text || sqlFiles.folders.length === 0) {
			rows.value = [];
			truncated.value = false;
			error.value = null;
			searching.value = false;
			return;
		}
		try {
			const result = await rpc.request.findInFiles(
				{
					folders: [...sqlFiles.folders],
					query: text,
					mask: mask.value ?? sqlFiles.filter,
					caseSensitive: caseSensitive.value,
					regex: regex.value,
					wholeWord: wholeWord.value,
				},
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
			if (ticket !== generation) return;
			rows.value = result.matches;
			truncated.value = result.truncated;
			error.value = result.error;
		} catch (err) {
			if (ticket !== generation) return;
			rows.value = [];
			error.value = errorMessage(err);
		}
		searching.value = false;
	}

	function scheduleSearch(): void {
		clearTimeout(searchTimer);
		searching.value = query.value.length > 0;
		searchTimer = window.setTimeout(() => {
			searchTimer = undefined;
			void search();
		}, SEARCH_DEBOUNCE_MS);
	}

	if (!watching) {
		watching = true;
		watch([query, caseSensitive, wholeWord, regex, mask], scheduleSearch);
	}

	function show(): void {
		if (mask.value === null) mask.value = sqlFiles.filter || "*";
		const selected = editorSelection();
		if (selected) query.value = selected;
		open.value = true;
	}

	function toggle(): void {
		if (open.value) open.value = false;
		else show();
	}

	/**
	 * Opens the row's file, reusing a tab already showing it (dirty buffer and
	 * all, like a bookmark jump), and asks the editor to select the hit.
	 */
	async function activate(row: FindInFilesMatch): Promise<void> {
		try {
			let tab = tabs.tabs.find((entry) => entry.path === row.path);
			if (!tab) {
				const resolution = resolveFileDatasource(
					row.path,
					sqlFiles.bindings,
					connections.sqlConfigs,
					connections.activeId,
				);
				if (!resolution) {
					toast("Add a connection first");
					return;
				}
				const { content } = await sqlFiles.read(row.path);
				tab = tabs.openQueryTab({ ...resolution.datasource, sql: content, path: row.path });
				tabs.rename(tab.id, row.path.split(/[/\\]/).pop() ?? row.path);
			}
			tabs.activate(tab.id);
			const first = row.ranges[0];
			bookmarks.pendingJump = {
				tabId: tab.id,
				line: row.line,
				column: row.column,
				length: first ? first[1] - first[0] : 0,
			};
			open.value = false;
		} catch (err) {
			toast(errorMessage(err));
		}
	}

	return {
		open,
		query,
		caseSensitive,
		wholeWord,
		regex,
		mask,
		rows,
		truncated,
		error,
		searching,
		show,
		toggle,
		activate,
	};
}
