import { defineStore } from "pinia";
import { ref, watch } from "vue";
import type {
	FileDatasource,
	SqlFileContent,
	SqlFileNode,
	SqlFileWriteResult,
} from "../../shared/sqlFile";
import { toast } from "../composables/useToast";
import { errorMessage, RPC_TIMEOUTS, rpc } from "../lib/rpc";
import { useTabsStore } from "./tabs";

const FOLDERS_KEY = "recall.sqlFileFolders";
const FILTER_KEY = "recall.sqlFileFilter";
const BINDINGS_KEY = "recall.sqlFileBindings";
const DEFAULT_FILTER = "*.sql";

/**
 * How many file→datasource bindings are remembered. The reference app uses the
 * same cap for the same reason: a user's working set of SQL files is bounded,
 * but localStorage is not, and an unbounded map would grow without limit.
 */
const MAX_BINDINGS = 200;

const PERSIST_DEBOUNCE_MS = 300;

/** A binding as stored on disk: the datasource plus when it was last touched. */
interface StoredBinding {
	path: string;
	connectionId: string;
	database: string;
	schema: string;
	updatedAt: number;
}

function isDatasource(value: unknown): value is FileDatasource {
	return (
		typeof value === "object" &&
		value !== null &&
		"connectionId" in value &&
		typeof value.connectionId === "string" &&
		"database" in value &&
		typeof value.database === "string" &&
		"schema" in value &&
		typeof value.schema === "string"
	);
}

function isStoredBinding(value: unknown): value is StoredBinding {
	return (
		typeof value === "object" &&
		value !== null &&
		"path" in value &&
		typeof value.path === "string" &&
		"updatedAt" in value &&
		typeof value.updatedAt === "number" &&
		isDatasource(value)
	);
}

/**
 * Reads and validates a persisted blob. Anything malformed is dropped rather
 * than trusted: the blob is user-writable and survives across app versions, so
 * its shape cannot be assumed.
 */
function readStored(key: string): unknown {
	try {
		const raw = localStorage.getItem(key);
		return raw === null ? null : JSON.parse(raw);
	} catch {
		return null;
	}
}

function writeStored(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage unavailable or over quota: the state stays in memory for
		// this session, which is the same degradation the other stores accept.
	}
}

function readFolders(): string[] {
	const parsed = readStored(FOLDERS_KEY);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(
		(entry): entry is string => typeof entry === "string" && entry.length > 0,
	);
}

function readFilter(): string {
	const parsed = readStored(FILTER_KEY);
	return typeof parsed === "string" && parsed.trim().length > 0
		? parsed
		: DEFAULT_FILTER;
}

/**
 * Bindings, newest first. Order is the recency order: the head is the most
 * recently set, so truncation at {@link MAX_BINDINGS} evicts the oldest.
 */
function readBindings(): StoredBinding[] {
	const parsed = readStored(BINDINGS_KEY);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isStoredBinding).slice(0, MAX_BINDINGS);
}

/** The directory holding `path`. Scan paths are `/`-separated, absolute. */
function parentDir(path: string): string {
	const index = path.lastIndexOf("/");
	return index > 0 ? path.slice(0, index) : path;
}

/** Depth-first lookup of one node inside a folder scan, or null. */
function findInTree(nodes: SqlFileNode[], target: string): SqlFileNode | null {
	for (const node of nodes) {
		if (node.path === target) return node;
		if (!node.isDir) continue;
		const hit = findInTree(node.children, target);
		if (hit) return hit;
	}
	return null;
}

export const useSqlFilesStore = defineStore("sqlFiles", () => {
	const folders = ref<string[]>(readFolders());
	const filter = ref<string>(readFilter());
	/** Last scan per folder. Refreshed on demand; there is no filesystem watcher. */
	const trees = ref<Record<string, SqlFileNode[]>>({});
	const bindings = ref<Record<string, FileDatasource>>({});
	/** Bound paths, newest first. Drives the persistence cap's eviction order. */
	const bindingOrder = ref<string[]>([]);
	/**
	 * The version token from the last read of each file, sent back on save.
	 * In memory only: a stale token from a previous session would produce a
	 * conflict against an unchanged file, so it is re-earned by reading.
	 */
	const versions = ref<Record<string, string>>({});
	/** Expanded directory paths. In memory only — expansion is a view concern. */
	const expanded = ref(new Set<string>());
	/** The row being renamed inline, or null while no rename is in progress. */
	const renamingPath = ref<string | null>(null);
	/**
	 * Rows cut or copied, and what a paste will do with them. Memory only —
	 * the clipboard is a session gesture, not something to restore on boot.
	 */
	const clipboard = ref<{ paths: string[]; mode: "cut" | "copy" } | null>(
		null,
	);

	// Restored newest-first, so the head is the most recently set binding and
	// the cap evicts from the tail.
	for (const entry of readBindings()) {
		bindings.value[entry.path] = {
			connectionId: entry.connectionId,
			database: entry.database,
			schema: entry.schema,
		};
		bindingOrder.value.push(entry.path);
	}

	let persistTimer: ReturnType<typeof setTimeout> | undefined;
	function schedulePersist(): void {
		clearTimeout(persistTimer);
		persistTimer = setTimeout(() => {
			writeStored(FOLDERS_KEY, folders.value);
			writeStored(FILTER_KEY, filter.value);
		}, PERSIST_DEBOUNCE_MS);
	}

	watch([folders, filter], schedulePersist, { deep: true });

	function persistBindings(): void {
		const now = Date.now();
		const stored: StoredBinding[] = bindingOrder.value.map((path) => ({
			path,
			...bindings.value[path],
			updatedAt: now,
		}));
		writeStored(BINDINGS_KEY, stored);
	}

	/**
	 * Adds a folder and scans it. A folder already open is left alone, so
	 * re-picking the same directory is not a surprise rescan.
	 */
	async function addFolder(path: string): Promise<void> {
		if (folders.value.includes(path)) return;
		folders.value.push(path);
		await refresh(path);
	}

	/**
	 * Closes a folder. Its bindings are deliberately kept: the user may reopen
	 * the folder in the next session, and a binding whose file happens to be
	 * gone is inert — it is never consulted for a path that is not in a tree.
	 */
	function removeFolder(path: string): void {
		folders.value = folders.value.filter((entry) => entry !== path);
		delete trees.value[path];
		// Expansion is per-view state; drop the entries under this folder so a
		// reopened folder starts collapsed rather than expanding into paths
		// whose nodes no longer exist.
		const prefix = `${path}/`;
		for (const entry of [...expanded.value]) {
			if (entry === path || entry.startsWith(prefix)) {
				expanded.value.delete(entry);
			}
		}
	}

	/**
	 * Rescans a folder. Never rejects: an unreadable folder (deleted, no longer
	 * permitted, on an unmounted volume) resolves to an empty tree and a toast,
	 * because a failed refresh that leaves the old tree on screen would show
	 * files that are no longer there.
	 */
	async function refresh(folder: string): Promise<void> {
		try {
			trees.value[folder] = await rpc.request.listFolder(
				{ folder, filter: filter.value },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
		} catch (err) {
			trees.value[folder] = [];
			toast(errorMessage(err));
		}
	}

	function toggleExpanded(path: string): void {
		if (expanded.value.has(path)) expanded.value.delete(path);
		else expanded.value.add(path);
	}

	function bindingFor(path: string): FileDatasource | undefined {
		return bindings.value[path];
	}

	/** Binds a file to a datasource, evicting the oldest binding past the cap. */
	function setBinding(path: string, datasource: FileDatasource): void {
		bindings.value[path] = datasource;
		const next = bindingOrder.value.filter((entry) => entry !== path);
		next.unshift(path);
		// Past the cap the tail is the least recently set, so it is what goes.
		bindingOrder.value = next.slice(0, MAX_BINDINGS);
		for (const evicted of next.slice(MAX_BINDINGS)) {
			delete bindings.value[evicted];
		}
		persistBindings();
	}

	/**
	 * Reads a file and remembers its version, so a later save can detect a
	 * change made outside the app. @throws when the file cannot be read; the
	 * caller toasts it.
	 */
	async function read(path: string): Promise<SqlFileContent> {
		const result = await rpc.request.readSqlFile(
			{ path },
			{ maxRequestTime: RPC_TIMEOUTS.metadata },
		);
		versions.value[path] = result.version;
		return result;
	}

	/**
	 * Re-earns a version token for each tab a previous session left behind.
	 *
	 * A tab's `path` and `savedSql` outlive the process, but a version token
	 * cannot: sending none means "create this file, refuse if it exists", so
	 * the first autosave after a restart would report a conflict against a file
	 * nobody had touched. The token is adopted only when the file still holds
	 * the text the tab was last saved with — when it does not, something wrote
	 * the file while the app was closed, and that write has to stay
	 * unguarded so the change is reported rather than overwritten.
	 *
	 * A file that is gone earns nothing either, and so the next save creates
	 * it — the same thing an unversioned path has always done, and the reason
	 * that path has no token to be checked against in the first place.
	 */
	async function rehydrateVersions(
		entries: ReadonlyArray<{ path: string; savedSql: string }>,
	): Promise<void> {
		for (const entry of entries) {
			try {
				// Not `read`: that adopts the token unconditionally, which is
				// the adoption this has to check for first.
				const result = await rpc.request.readSqlFile(
					{ path: entry.path },
					{ maxRequestTime: RPC_TIMEOUTS.metadata },
				);
				if (result.content === entry.savedSql) {
					versions.value[entry.path] = result.version;
				}
			} catch {
				// Nothing to earn. The next save reports the reason.
			}
		}
	}

	/**
	 * Saves a file, guarded by the version from the last read.
	 *
	 * A conflict is returned rather than thrown: it is an expected outcome the
	 * UI has to offer a choice about (reload from disk / overwrite / cancel),
	 * not an error. Only a transport failure throws.
	 */
	async function save(path: string, content: string): Promise<SqlFileWriteResult> {
		try {
			const result = await rpc.request.writeSqlFile(
				{ path, content, expectedVersion: versions.value[path] ?? null },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
			if (result.ok) versions.value[path] = result.version;
			return result;
		} catch (err) {
			throw new Error(errorMessage(err));
		}
	}

	/** Opens the native directory picker. Resolves null when the user cancels. */
	async function pickFolder(): Promise<string | null> {
		return rpc.request.pickFolder({}, { maxRequestTime: Infinity });
	}

	/** Reveals a file in Finder / Explorer. */
	async function revealInFolder(path: string): Promise<void> {
		await rpc.request.revealInFolder(
			{ path },
			{ maxRequestTime: RPC_TIMEOUTS.metadata },
		);
	}

	// ---- Mutating the tree -------------------------------------------------
	//
	// Every operation below is a round trip that ends in a rescan, because
	// there is no filesystem watcher: the tree on screen is only ever as true
	// as the last `refresh` call. A refusal comes back as data (`reason`), so
	// it becomes a toast; a transport failure is caught here too, which means
	// no file operation can ever reject into the UI.

	/**
	 * The open folder roots that can see `target`: a folder that IS the target
	 * (a create at the top level) counts, and so does any tree holding it as a
	 * node. Asked against the scans still in memory, which is why a delete can
	 * still find the folder the row it just removed came from.
	 */
	function foldersContaining(target: string): string[] {
		return folders.value.filter(
			(folder) =>
				folder === target ||
				Boolean(findInTree(trees.value[folder] ?? [], target)),
		);
	}

	/**
	 * Rescans every folder that can see any of `targets`. Deduped because a
	 * paste touches both ends and both usually sit in the same tree.
	 */
	async function refreshHolding(targets: string[]): Promise<void> {
		const hits = new Set<string>();
		for (const target of targets) {
			for (const folder of foldersContaining(target)) hits.add(folder);
		}
		for (const folder of hits) await refresh(folder);
	}

	/** Paths of the open tabs bound to `path` or to anything under it. */
	function tabPathsAt(path: string): string[] {
		const prefix = `${path}/`;
		const paths: string[] = [];
		for (const tab of useTabsStore().tabs) {
			const tabPath = tab.path;
			if (tabPath === undefined) continue;
			if (tabPath === path || tabPath.startsWith(prefix)) paths.push(tabPath);
		}
		return paths;
	}

	/**
	 * Closes every tab bound to `path` or below it. A deleted file leaves
	 * nothing to save into, so the tabs go rather than being held back for
	 * unsaved SQL the user can no longer put anywhere.
	 */
	function closeTabsAt(path: string): void {
		const tabs = useTabsStore();
		for (const tabPath of tabPathsAt(path)) tabs.repath(tabPath, null);
	}

	/** Drops the expansion of `path` and everything under it. */
	function collapseSubtree(path: string): void {
		const prefix = `${path}/`;
		for (const entry of [...expanded.value]) {
			if (entry === path || entry.startsWith(prefix)) expanded.value.delete(entry);
		}
	}

	/**
	 * Carries the path-keyed state across a rename: a renamed file is the same
	 * document, so its binding, its version token and its expansion belong to
	 * the new path rather than to a name that no longer exists.
	 */
	function followRename(from: string, to: string): void {
		if (from === to) return;
		const binding = bindings.value[from];
		if (binding) {
			bindings.value[to] = binding;
			delete bindings.value[from];
			bindingOrder.value = bindingOrder.value.map((entry) =>
				entry === from ? to : entry,
			);
			persistBindings();
		}
		const version = versions.value[from];
		if (version !== undefined) {
			versions.value[to] = version;
			delete versions.value[from];
		}
		const prefix = `${from}/`;
		for (const entry of [...expanded.value]) {
			if (entry === from) {
				expanded.value.delete(entry);
				expanded.value.add(to);
			} else if (entry.startsWith(prefix)) {
				expanded.value.delete(entry);
				expanded.value.add(`${to}/${entry.slice(prefix.length)}`);
			}
		}
	}

	/**
	 * Creates an empty file or directory under `parent`. Refreshes the folders
	 * that can see `parent` so the new row appears without reopening the panel.
	 */
	async function createEntry(
		parent: string,
		name: string,
		isDir: boolean,
	): Promise<void> {
		try {
			const result = await rpc.request.createSqlEntry(
				{ parent, name, isDir },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
			if (!result.ok) {
				toast(result.message);
				return;
			}
			await refreshHolding([parent]);
		} catch (err) {
			toast(errorMessage(err));
		}
	}

	/**
	 * Renames one entry. A tab open on it follows the new path — the document
	 * did not change, only where it lives — and the affected folders rescan.
	 */
	async function renameEntry(path: string, name: string): Promise<void> {
		try {
			const result = await rpc.request.renameSqlEntry(
				{ path, name },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
			if (!result.ok) {
				toast(result.message);
				return;
			}
			followRename(path, result.path);
			useTabsStore().repath(path, result.path);
			await refreshHolding([path]);
		} catch (err) {
			toast(errorMessage(err));
		}
	}

	/**
	 * Deletes one entry, recursively for a directory. Tabs bound to it are
	 * closed: the file they point at is gone, so there is no longer anywhere
	 * for their SQL to be saved. Bindings are kept for the same reason
	 * {@link removeFolder} keeps them — a rename back restores the mapping.
	 */
	async function deleteEntry(path: string): Promise<void> {
		try {
			const result = await rpc.request.deleteSqlEntry(
				{ path },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
			if (!result.ok) {
				toast(result.message);
				return;
			}
			closeTabsAt(path);
			collapseSubtree(path);
			await refreshHolding([path]);
		} catch (err) {
			toast(errorMessage(err));
		}
	}

	/** The scanned node for `path`, or null when no open tree holds it. */
	function findNode(path: string): SqlFileNode | null {
		for (const folder of folders.value) {
			const hit = findInTree(trees.value[folder] ?? [], path);
			if (hit) return hit;
		}
		return null;
	}

	/**
	 * The entries sharing a directory with `path`, read off the scans already
	 * in hand. A top-level row's directory is an opened folder rather than a
	 * node, so it falls back to that folder's own root entries.
	 */
	function siblingsOf(path: string): SqlFileNode[] {
		const parent = findNode(parentDir(path));
		if (parent) return parent.children;
		const folder = folders.value.find((root) => path.startsWith(`${root}/`));
		return folder ? (trees.value[folder] ?? []) : [];
	}

	/**
	 * A name no sibling holds: `q.sql` → `q copy.sql` → `q copy 2.sql`.
	 * Siblings come from the scan already in hand, so the common case costs no
	 * round trip; a name still taken on disk comes back as an `exists` failure.
	 */
	function duplicateName(node: SqlFileNode): string {
		const dot = node.isDir ? -1 : node.name.lastIndexOf(".");
		const stem = dot > 0 ? node.name.slice(0, dot) : node.name;
		const ext = dot > 0 ? node.name.slice(dot) : "";
		const siblings = new Set(
			siblingsOf(node.path).map((child) => child.name),
		);
		let candidate = `${stem} copy${ext}`;
		let counter = 2;
		while (siblings.has(candidate)) {
			candidate = `${stem} copy ${counter}${ext}`;
			counter += 1;
		}
		return candidate;
	}

	/**
	 * Copies a file next to itself, under a name no sibling holds.
	 *
	 * Not a transfer: a copy into the directory it already sits in targets the
	 * name it already has, which the backend refuses. So the copy is made the
	 * way this store makes files — create it, then write the source's text into
	 * it. The version token is earned by reading the empty placeholder first,
	 * because a write with no expectation means "create this file" and would
	 * be refused against the one that now exists.
	 *
	 * Directories are not duplicated: only the filesystem's own recursive copy
	 * can do that faithfully, and it is not exposed here.
	 */
	async function duplicateEntry(path: string): Promise<void> {
		const node = findNode(path);
		if (!node) {
			toast("That entry is no longer in the tree");
			return;
		}
		if (node.isDir) {
			toast("Folders cannot be duplicated");
			return;
		}
		try {
			const { content } = await read(path);
			const created = await rpc.request.createSqlEntry(
				{ parent: parentDir(path), name: duplicateName(node), isDir: false },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
			if (!created.ok) {
				toast(created.message);
				return;
			}
			await read(created.path);
			const written = await save(created.path, content);
			if (!written.ok) {
				toast(`Could not write the copy of ${node.name}`);
				return;
			}
			await refreshHolding([path]);
		} catch (err) {
			toast(errorMessage(err));
		}
	}

	function cut(paths: string[]): void {
		clipboard.value = { paths: [...paths], mode: "cut" };
	}

	function copy(paths: string[]): void {
		clipboard.value = { paths: [...paths], mode: "copy" };
	}

	function clearClipboard(): void {
		clipboard.value = null;
	}

	/**
	 * Pastes the clipboard into `destination`. A cut retargets: the document
	 * did not change, only where it lives, so the tab open on a moved file
	 * keeps its unsaved SQL, its datasource and its place in the strip and
	 * follows the file to its new path. Following is unambiguous because the
	 * batch result pairs every landed entry with the source it came from — the
	 * refused rows are named separately in `failures`, so a partial paste
	 * still retargets exactly the rows that moved.
	 *
	 * A copy leaves the originals, and with them their tabs, where they were;
	 * only the new file is bound, and binding the copy is left to the user.
	 *
	 * The clipboard survives an all-or-nothing refusal so the user can paste
	 * somewhere else; it is cleared only once something actually moved.
	 */
	async function paste(destination: string): Promise<void> {
		const clip = clipboard.value;
		if (!clip || clip.paths.length === 0) {
			toast("Nothing to paste");
			return;
		}
		try {
			const result = await rpc.request.transferSqlEntries(
				{ sources: clip.paths, destination, move: clip.mode === "cut" },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
			for (const failure of result.failures) toast(failure.message);
			if (result.moved.length === 0) return;
			if (clip.mode === "cut") {
				for (const { from, to } of result.moved) {
					followRename(from, to);
					useTabsStore().repath(from, to);
				}
				clipboard.value = null;
			}
			await refreshHolding([destination, ...clip.paths]);
		} catch (err) {
			toast(errorMessage(err));
		}
	}

	return {
		folders,
		filter,
		trees,
		bindings,
		bindingOrder,
		expanded,
		renamingPath,
		clipboard,
		addFolder,
		removeFolder,
		refresh,
		foldersContaining,
		toggleExpanded,
		bindingFor,
		setBinding,
		read,
		save,
		rehydrateVersions,
		createEntry,
		renameEntry,
		deleteEntry,
		duplicateEntry,
		cut,
		copy,
		clearClipboard,
		paste,
		pickFolder,
		revealInFolder,
	};
});
