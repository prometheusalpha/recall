/**
 * Mnemonic bookmarks, as the renderer sees them.
 *
 * A bookmark is one character bound to a line of a `.sql` file. It lives in the
 * app's SQLite database — never in the `.sql` file itself — so the file stays
 * exactly as the user wrote it and a bookmark cannot outlive its file.
 *
 * The editor owns the caret; this store owns the mapping and says where to put
 * it. A jump opens the file (if it is not already on screen), re-anchors the
 * line against the file's current text, and hands the editor a pending jump
 * that the editor consumes once the document it names is the visible one.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { Bookmark } from "../../shared/bookmark";
import { RPC_TIMEOUTS, errorMessage, rpc } from "../lib/rpc";
import { resolveFileDatasource } from "../lib/fileDatasource";
import { toast } from "../composables/useToast";
import { useConnectionsStore } from "./connections";
import { useSqlFilesStore } from "./sqlFiles";
import { useTabsStore } from "./tabs";

/** A jump waiting for the editor to show the tab it names. */
interface PendingJump {
	tabId: string;
	line: number;
}

export const useBookmarksStore = defineStore("bookmarks", () => {
	const rows = ref<Bookmark[]>([]);
	const pendingJump = ref<PendingJump | null>(null);

	const byMnemonic = computed(
		() => new Map(rows.value.map((row) => [row.mnemonic, row])),
	);

	/** Bookmarks for one file, as line -> mnemonic, for the gutter to draw. */
	function forPath(path: string | undefined): Map<number, string> {
		const marks = new Map<number, string>();
		if (!path) return marks;
		for (const row of rows.value) {
			if (row.path === path) marks.set(row.line, row.mnemonic);
		}
		return marks;
	}

	/** Reads every bookmark. Rows whose file is gone are dropped by the backend. */
	async function load(): Promise<void> {
		try {
			rows.value = await rpc.request.listBookmarks(
				{},
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
		} catch (err) {
			toast(errorMessage(err));
		}
	}

	/**
	 * Binds a mnemonic to a line. `lineText` is the line itself: only the
	 * editor has it, and the backend needs it to digest.
	 */
	async function assign(
		mnemonic: string,
		path: string,
		line: number,
		lineText: string,
	): Promise<void> {
		try {
			await rpc.request.setBookmark(
				{ mnemonic, path, line, lineText },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
			await load();
		} catch (err) {
			toast(errorMessage(err));
		}
	}

	/** Drops a bookmark, leaving the file untouched. */
	async function remove(mnemonic: string): Promise<void> {
		try {
			await rpc.request.clearBookmark(
				{ mnemonic },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
			await load();
		} catch (err) {
			toast(errorMessage(err));
		}
	}

	/**
	 * Opens whatever a mnemonic points at and asks the editor to put its caret
	 * there. The file is read only when no tab is showing it yet; a tab that is
	 * already open is left as it is, dirty buffer and all.
	 */
	async function jump(mnemonic: string): Promise<void> {
		const connections = useConnectionsStore();
		const sqlFiles = useSqlFilesStore();
		const tabs = useTabsStore();

		const stored = byMnemonic.value.get(mnemonic);
		if (!stored) return;

		try {
			const existing = tabs.tabs.find((tab) => tab.path === stored.path);
			let text = existing?.sql;
			let tab = existing;
			if (!tab) {
				const resolution = resolveFileDatasource(
					stored.path,
					sqlFiles.bindings,
					connections.configs,
					connections.activeId,
				);
				if (!resolution) {
					toast("Add a connection first");
					return;
				}
				await connections.ensureConnected(resolution.datasource.connectionId);
				text = (await sqlFiles.read(stored.path)).content;
				tab = tabs.openQueryTab({
					connectionId: resolution.datasource.connectionId,
					database: resolution.datasource.database,
					schema: resolution.datasource.schema,
					sql: text,
					path: stored.path,
				});
				tabs.rename(tab.id, basenameOf(stored.path));
			}

			// The stored line number may have drifted; the backend finds it again
			// from the digest and writes the corrected number back.
			const resolved = await rpc.request.resolveBookmark(
				{ mnemonic, text: text ?? "" },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
			if (!resolved) {
				await load();
				toast(`Bookmark ${mnemonic} is gone — its file was deleted`);
				return;
			}
			await load();
			// An already-open tab is not on screen: `openQueryTab` activated the
			// new one for us, but nothing has to raise an old one. Without this
			// the caret lands on a line nobody is looking at, and the jump is
			// only applied once the user happens to click the tab themselves.
			tabs.activate(tab.id);
			pendingJump.value = { tabId: tab.id, line: resolved.line };
		} catch (err) {
			toast(errorMessage(err));
		}
	}

	return { rows, pendingJump, byMnemonic, forPath, load, assign, remove, jump };
});

/** File name without directories, for the tab title. */
function basenameOf(path: string): string {
	return path.split(/[/\\]/).pop() ?? path;
}