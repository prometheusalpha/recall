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

	return {
		folders,
		filter,
		trees,
		bindings,
		bindingOrder,
		expanded,
		addFolder,
		removeFolder,
		refresh,
		toggleExpanded,
		bindingFor,
		setBinding,
		read,
		save,
		pickFolder,
		revealInFolder,
	};
});
