/**
 * Filesystem layer for the "open folder" feature: scanning a directory of SQL
 * files, reading/writing them with optimistic concurrency, and creating,
 * renaming, deleting, and moving/copying the entries a tree scan returned.
 *
 * Scanning enforces path safety (`realpathInside`, below). The mutation
 * functions have no root to check against — they operate on paths the scan
 * already vetted — so what keeps a mutation inside the opened folder is the
 * name validation they all share.
 *
 * Deliberately free of `electrobun/main` so this module stays loadable by a
 * plain `bun run` process, which is how every path-safety rule below is
 * exercised. The two handlers that do need the native picker live in `rpc.ts`.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	cp,
	mkdir,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type {
	SqlFileContent,
	SqlFileNode,
	SqlFileOpBatchResult,
	SqlFileOpFailure,
	SqlFileOpResult,
	SqlFileWriteResult,
} from "../shared/sqlFile";

/** Recursion cap. A folder tree deeper than this is almost certainly not SQL. */
const MAX_SCAN_DEPTH = 10;

/** Largest file the editor will open. Anything larger is refused, not truncated. */
const MAX_READ_BYTES = 8 * 1024 * 1024;

const DEFAULT_FILTER = "*.sql";

/**
 * Directories that are never interesting for SQL browsing and are often huge
 * enough (tens of thousands of entries) to stall a scan. Skipped outright.
 */
const IGNORE_DIRS = new Set([
	".git",
	"node_modules",
	".venv",
	"dist",
	"build",
	".next",
	"target",
	"__pycache__",
	".idea",
	".cache",
]);

/**
 * Resolves `entry` through symlinks and returns it only if it really lives
 * inside `root` (which must itself already be a realpath).
 *
 * This is the whole path-safety story: a symlink dropped into an opened folder
 * must not become a window onto the rest of the filesystem, so a link whose
 * target resolves outside the root is dropped rather than followed. Returns null
 * for both "resolved outside" and "could not be resolved at all", so callers
 * have a single skip path.
 */
async function realpathInside(
	root: string,
	entry: string,
): Promise<string | null> {
	let resolved: string;
	try {
		resolved = await realpath(entry);
	} catch {
		// Broken link, or a race with a delete.
		return null;
	}
	if (resolved === root) return resolved;
	const rel = relative(root, resolved);
	// A leading `..` means it climbed out; an absolute result means the two
	// paths sit on different roots (different drives on Windows).
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
		? resolved
		: null;
}

/** Compiled filters, keyed by pattern. The user edits one filter at a time. */
const filterCache = new Map<string, RegExp>();

/**
 * Glob support, deliberately minimal: `*`, `?`, and one level of `{a,b}`
 * alternation, which is what the reference app offers and covers `*.sql`,
 * `*.{sql,md}` and a bare `*`. Anything else is matched literally. Matching is
 * case-insensitive, because macOS and Windows filesystems are.
 */
function globToRegExp(pattern: string): RegExp {
	let source = "^";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === "*") {
			source += ".*";
		} else if (char === "?") {
			source += ".";
		} else if (char === "{") {
			const close = pattern.indexOf("}", i);
			if (close === -1) {
				source += "\\{";
				continue;
			}
			const alternatives = pattern
				.slice(i + 1, close)
				.split(",")
				.map((alternative) => alternative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
				.join("|");
			source += `(?:${alternatives})`;
			i = close;
		} else {
			source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`, "i");
}

/** Compiles a filter pattern, memoised and bounded so a long typing session cannot grow it without limit. */
function compileFilter(filter: string): RegExp {
	const pattern = filter.trim() || DEFAULT_FILTER;
	const cached = filterCache.get(pattern);
	if (cached) return cached;
	const compiled = globToRegExp(pattern);
	if (filterCache.size >= 32) filterCache.clear();
	filterCache.set(pattern, compiled);
	return compiled;
}

/** True when a filename matches the folder's filter. An empty filter means `*.sql`. */
export function matchesFilter(name: string, filter: string): boolean {
	return compileFilter(filter).test(name);
}

/**
 * Content-addressed version token. The caller never interprets it; it is only
 * compared for equality against a later read of the same file.
 */
export function versionFor(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Directories first, then case-insensitively by name — the reference app's order. */
function compareNodes(a: SqlFileNode, b: SqlFileNode): number {
	if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
	return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

/**
 * A directory node, or null when it holds nothing that matches the filter.
 * Empty directories are omitted so the tree shows only what can be opened.
 */
async function directoryNode(
	root: string,
	real: string,
	name: string,
	depth: number,
	filter: string,
	visited: Set<string>,
): Promise<SqlFileNode | null> {
	// A symlinked directory that points back up the tree would otherwise
	// recurse forever; the depth cap bounds the damage but not the node count,
	// so each real directory is scanned at most once per walk.
	if (visited.has(real)) return null;
	visited.add(real);
	const children = await scanDirectory(root, real, depth + 1, filter, visited);
	if (children.length === 0) return null;
	return { path: real, name, isDir: true, children };
}

async function scanDirectory(
	root: string,
	dir: string,
	depth: number,
	filter: string,
	visited: Set<string>,
): Promise<SqlFileNode[]> {
	if (depth > MAX_SCAN_DEPTH) return [];

	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		// An unreadable subdirectory is skipped, not fatal: the rest of the
		// folder is still browsable.
		return [];
	}

	const nodes: SqlFileNode[] = [];
	for (const entry of entries) {
		const name = entry.name;
		const real = await realpathInside(root, join(dir, name));
		if (real === null) continue;

		if (entry.isDirectory()) {
			if (IGNORE_DIRS.has(name.toLowerCase())) continue;
			const node = await directoryNode(root, real, name, depth, filter, visited);
			if (node) nodes.push(node);
			continue;
		}

		if (entry.isSymbolicLink()) {
			// A link's dirent type describes the link, not the target, so the
			// target has to be stat'ed before it can be classified.
			let targetIsDir: boolean;
			try {
				targetIsDir = (await stat(real)).isDirectory();
			} catch {
				continue;
			}
			if (targetIsDir) {
				const node = await directoryNode(root, real, name, depth, filter, visited);
				if (node) nodes.push(node);
			} else if (matchesFilter(name, filter)) {
				nodes.push({ path: real, name, isDir: false, children: [] });
			}
			continue;
		}

		if (entry.isFile() && matchesFilter(name, filter)) {
			nodes.push({ path: real, name, isDir: false, children: [] });
		}
	}

	nodes.sort(compareNodes);
	return nodes;
}

/**
 * Recursive scan of `folder`, returning only paths that resolve inside it.
 *
 * @throws when the folder itself cannot be opened. The caller decides whether
 * that is worth surfacing; a partial scan is never returned instead, because a
 * silently empty tree reads as "no SQL files here".
 */
export async function listSqlFiles(
	folder: string,
	filter: string,
): Promise<SqlFileNode[]> {
	let root: string;
	try {
		root = await realpath(folder);
	} catch (error) {
		throw new Error(`Cannot open folder: ${message(error)}`);
	}
	if (!(await stat(root)).isDirectory()) {
		throw new Error("Cannot open folder: not a directory");
	}
	return scanDirectory(root, root, 0, filter, new Set([root]));
}

/** Message for a filesystem failure, naming the path but never its contents. */
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a file and the version token that must accompany any later write.
 *
 * @throws when the file is missing, unreadable, or larger than 8 MiB. The size
 * is checked before the read, so an oversized file is never loaded.
 */
export async function readSqlFile(path: string): Promise<SqlFileContent> {
	let size: number;
	try {
		size = (await stat(path)).size;
	} catch (error) {
		throw new Error(`Cannot open file: ${message(error)}`);
	}
	if (size > MAX_READ_BYTES) {
		throw new Error(
			`File is too large to open (${Math.round(size / 1024 / 1024)} MB, limit ${MAX_READ_BYTES / 1024 / 1024} MB)`,
		);
	}
	let content: string;
	try {
		content = await readFileUtf8(path);
	} catch (error) {
		throw new Error(`Cannot open file: ${message(error)}`);
	}
	return { content, version: versionFor(content) };
}

async function readFileUtf8(path: string): Promise<string> {
	const bytes = await Bun.file(path).arrayBuffer();
	return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Hashes a file without holding it in memory, so the conflict check stays
 * cheap even for a file the editor would refuse to open.
 *
 * @returns the version token, or null when the file does not exist.
 */
async function currentVersion(path: string): Promise<string | null> {
	const hash = createHash("sha256");
	try {
		await new Promise<void>((resolve, reject) => {
			const stream = createReadStream(path);
			stream.on("data", (chunk: Uint8Array) => hash.update(chunk));
			stream.on("error", reject);
			stream.on("end", resolve);
		});
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return null;
		}
		throw new Error(
			`Cannot read the file to check it for changes: ${message(error)}`,
		);
	}
	return hash.digest("hex");
}

/**
 * Writes `content` only if the file on disk still matches what the caller last
 * read. `expectedVersion` is that token, or null for "create this file, and
 * refuse if anything is already there".
 *
 * On a conflict nothing is written and the caller gets the version currently on
 * disk, which is what the reload/overwrite choice is made against. This is the
 * check that stops an edit made outside the app from being silently clobbered.
 */
export async function writeSqlFile(
	path: string,
	content: string,
	expectedVersion: string | null,
): Promise<SqlFileWriteResult> {
	const current = await currentVersion(path);
	if (expectedVersion === null) {
		if (current !== null) {
			return { ok: false, reason: "conflict", currentVersion: current };
		}
	} else if (current === null) {
		return { ok: false, reason: "missing", currentVersion: null };
	} else if (current !== expectedVersion) {
		return { ok: false, reason: "conflict", currentVersion: current };
	}

	try {
		await writeFile(path, content, "utf8");
	} catch (error) {
		throw new Error(`Cannot save file: ${message(error)}`);
	}
	return { ok: true, version: versionFor(content) };
}

/** The `code` of a filesystem error, or null when it is not one. */
function code(error: unknown): string | null {
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
	) {
		return error.code;
	}
	return null;
}

/**
 * Whether `path` is free to be written, from a single `stat`.
 *
 * `ENOENT` is the only error that means "free" — anything else (EACCES, EIO)
 * means the filesystem did not answer the question, which is never a green
 * light. Splitting those apart is what keeps a caller from turning an
 * unreadable destination into a blind write.
 */
async function pathState(path: string): Promise<"free" | "taken" | "unknown"> {
	try {
		await stat(path);
		return "taken";
	} catch (error) {
		return code(error) === "ENOENT" ? "free" : "unknown";
	}
}

/**
 * A single path segment, checked before it is ever joined onto a directory.
 * Empty, `.`, `..`, anything holding a separator or a NUL is refused, which is
 * what stops a name typed in the UI from escaping the folder it was typed in.
 *
 * @returns the refusal message, or null when the name is usable.
 */
function nameProblem(name: string): string | null {
	if (name.trim().length === 0) {
		return "Name cannot be empty.";
	}
	if (name === "." || name === "..") {
		return `"${name}" is not a name.`;
	}
	if (name.includes("/") || name.includes("\\")) {
		return "Name cannot contain a path separator.";
	}
	if (name.includes("\0")) {
		return "Name cannot contain a NUL character.";
	}
	return null;
}

/**
 * Creates an empty file or a directory under `parent`.
 *
 * `parent` is expected to be a directory that already came out of
 * `listSqlFiles`, so it was resolved inside the opened folder by
 * `realpathInside`; what keeps the new entry there is `nameProblem`.
 *
 * Both branches refuse a name already in use rather than replacing what is
 * there: `mkdir` without `recursive` raises `EEXIST` on its own, and the file
 * is written with the `wx` flag — exclusive create — because a plain write
 * truncates an existing file to zero bytes and would report success while
 * destroying the user's file.
 *
 * @returns the new path, or `exists` when something is already there. Never
 * throws: a refused name is data the UI shows next to the field.
 */
export async function createSqlEntry(
	parent: string,
	name: string,
	isDir: boolean,
): Promise<SqlFileOpResult> {
	const problem = nameProblem(name);
	if (problem) {
		return { ok: false, reason: "invalid", message: problem };
	}
	const path = join(parent, name);
	try {
		if (isDir) {
			await mkdir(path);
		} else {
			await writeFile(path, "", { encoding: "utf8", flag: "wx" });
		}
	} catch (error) {
		if (code(error) === "EEXIST") {
			return {
				ok: false,
				reason: "exists",
				message: `"${name}" already exists in this folder.`,
			};
		}
		return { ok: false, reason: "invalid", message: message(error) };
	}
	return { ok: true, path };
}

/**
 * Renames one entry in place, staying in the directory it already sits in.
 *
 * The path came from `listSqlFiles` (already resolved inside the opened
 * folder); `nameProblem` is what stops the new name from leaving that
 * directory, since a rename never changes a path's directory part.
 *
 * The destination is checked (`pathState`) before the rename rather than
 * after, because POSIX `rename` atomically *replaces* an existing
 * destination — there is no error to catch, so a collision checked only in
 * the catch block would silently destroy the file that held the name. The
 * `EEXIST`/`ENOTEMPTY` branches below stay as the second line of defence for
 * the racy window between the check and the rename.
 *
 * @returns the new path, `missing` when the source is gone, or `exists` when
 * the destination is taken. Never throws.
 */
export async function renameSqlEntry(
	path: string,
	name: string,
): Promise<SqlFileOpResult> {
	const problem = nameProblem(name);
	if (problem) {
		return { ok: false, reason: "invalid", message: problem };
	}
	const destination = join(dirname(path), name);
	const state = await pathState(destination);
	if (state === "taken") {
		return {
			ok: false,
			reason: "exists",
			message: `"${name}" already exists in this folder.`,
		};
	}
	if (state === "unknown") {
		return {
			ok: false,
			reason: "invalid",
			message: `"${name}" could not be checked: the filesystem refused the lookup.`,
		};
	}
	try {
		await rename(path, destination);
	} catch (error) {
		const failure = code(error);
		if (failure === "ENOENT") {
			return {
				ok: false,
				reason: "missing",
				message: "The entry no longer exists.",
			};
		}
		if (failure === "EEXIST" || failure === "ENOTEMPTY") {
			return {
				ok: false,
				reason: "exists",
				message: `"${name}" already exists in this folder.`,
			};
		}
		return { ok: false, reason: "invalid", message: message(error) };
	}
	return { ok: true, path: destination };
}

/**
 * Deletes one entry, recursively for a directory.
 *
 * The path came from `listSqlFiles` and was resolved inside the opened
 * folder; deleting is not given a name to validate because it only ever
 * removes exactly the path it was handed.
 *
 * @returns `missing` when there was nothing to delete — a tree refreshed
 * behind the user's back is not an error they caused. Never throws.
 */
export async function deleteSqlEntry(
	path: string,
): Promise<SqlFileOpResult> {
	try {
		await rm(path, { recursive: true, force: false });
	} catch (error) {
		if (code(error) === "ENOENT") {
			return {
				ok: false,
				reason: "missing",
				message: "The entry no longer exists.",
			};
		}
		return { ok: false, reason: "invalid", message: message(error) };
	}
	return { ok: true, path };
}

/**
 * Copies (`move: false`) or moves (`move: true`) each entry into
 * `destination`. Per-entry rather than all-or-nothing: one refused entry lands
 * in `failures` and the rest still land in `moved`.
 *
 * Both arguments are expected to come from `listSqlFiles`, which already
 * resolved them inside the opened folder. The destination is only ever
 * appended to, never derived from a name, and a destination inside its own
 * source is refused — copying a directory into itself would otherwise recurse
 * until the disk filled.
 *
 * @returns one `{ from, to }` per entry that landed, in request order, each
 * naming the source it came from — that pairing is what lets a caller repair
 * state keyed on the old path, and it survives a partial batch because every
 * entry names its own source rather than relying on position. Never throws.
 */
export async function transferSqlEntries(
	sources: string[],
	destination: string,
	move: boolean,
): Promise<SqlFileOpBatchResult> {
	const moved: { from: string; to: string }[] = [];
	const failures: SqlFileOpFailure[] = [];

	for (const source of sources) {
		const name = source.slice(source.lastIndexOf("/") + 1);
		const target = join(destination, name);
		const refusal = await transferRefusal(source, target, destination);
		if (refusal) {
			failures.push({ path: source, message: refusal });
			continue;
		}
		const failure = move
			? await moveEntry(source, target)
			: await copyEntry(source, target);
		if (failure) {
			failures.push({ path: source, message: failure });
			continue;
		}
		moved.push({ from: source, to: target });
	}

	return { moved, failures };
}

/**
 * Copies one entry into place.
 *
 * @returns the failure message, or null on success.
 */
async function copyEntry(
	source: string,
	target: string,
): Promise<string | null> {
	try {
		await cp(source, target, { recursive: true });
		return null;
	} catch (error) {
		return message(error);
	}
}

/**
 * Moves one entry into place. `rename` is the cheap path; it cannot cross a
 * filesystem boundary, so EXDEV falls back to a copy followed by a removal.
 *
 * @returns the failure message, or null on success.
 */
async function moveEntry(
	source: string,
	target: string,
): Promise<string | null> {
	try {
		await rename(source, target);
		return null;
	} catch (error) {
		if (code(error) !== "EXDEV") {
			return message(error);
		}
		const copied = await copyEntry(source, target);
		if (copied) {
			return copied;
		}
		try {
			await rm(source, { recursive: true, force: true });
		} catch (removalError) {
			return `The copy succeeded but the original could not be removed: ${message(removalError)}`;
		}
		return null;
	}
}

/**
 * Why one entry cannot be transferred, or null when it can. Checked before any
 * filesystem write so a refusal never leaves half a copy behind.
 */
async function transferRefusal(
	source: string,
	target: string,
	destination: string,
): Promise<string | null> {
	if (destination === source || destination.startsWith(`${source}/`)) {
		return "An entry cannot be moved into itself.";
	}
	try {
		await stat(source);
	} catch (error) {
		return code(error) === "ENOENT"
			? "The entry no longer exists."
			: message(error);
	}
	if ((await pathState(target)) === "taken") {
		return `"${target.slice(target.lastIndexOf("/") + 1)}" already exists in the destination.`;
	}
	return null;
}
