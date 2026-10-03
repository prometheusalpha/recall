/**
 * Filesystem layer for the "open folder" feature: scanning a directory of SQL
 * files and reading/writing them with optimistic concurrency.
 *
 * Deliberately free of `electrobun/main` so this module stays loadable by a
 * plain `bun run` process, which is how every path-safety rule below is
 * exercised. The two handlers that do need the native picker live in `rpc.ts`.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type {
	SqlFileContent,
	SqlFileNode,
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
