/**
 * Find in Files: spawns the bundled ripgrep over the opened SQL folders and
 * turns its `--json` stream into rows the renderer can draw and jump to.
 *
 * Free of `electrobun/main` like `./sqlFiles`, so tests can run it with a
 * plain `bun`; `rpc.ts` resolves the binary inside the app bundle and hands
 * the path over through {@link setRipgrepPath}.
 */
import { realpath } from "node:fs/promises";
import type { Subprocess } from "bun";
import type {
	FindInFilesMatch,
	FindInFilesRequest,
	FindInFilesResult,
} from "../shared/findInFiles";
import { IGNORE_DIRS } from "./sqlFiles";

/** Rows returned at most. Past this the list is noise; the user refines the query. */
export const MAX_ROWS = 500;

/** A line longer than this is clipped around its first hit. */
const MAX_LINE_CHARS = 400;

/** How much of the line to keep before the first hit when clipping. */
const CLIP_LEAD = 80;

let ripgrepPath: string | null = null;

export function setRipgrepPath(path: string): void {
	ripgrepPath = path;
}

/**
 * The search in flight. One at a time: the modal searches as the user types,
 * and a result for a query they have already typed past is worth nothing, so
 * a new search kills the old process instead of queueing behind it.
 */
let running: Subprocess | null = null;

/**
 * Which call is the newest, taken on entry. Superseding goes by call order,
 * not spawn order: the realpath awaits can let an older call spawn after a
 * newer one, and that older call must not become the one that answers.
 */
let latest = 0;

/**
 * Splits a mask on commas that are not inside braces, so `*.{sql,md}` (the
 * tree's own filter syntax) stays one glob.
 */
export function splitMask(mask: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const char of mask) {
		if (char === "{") depth += 1;
		else if (char === "}") depth = Math.max(0, depth - 1);
		if (char === "," && depth === 0) {
			parts.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter((part) => part && part !== "*");
}

/**
 * Flags chosen to search what the file tree shows, not what git tracks: the
 * tree lists hidden and ignored files, so `--hidden --no-ignore`, and it skips
 * the same IGNORE_DIRS. Symlinks are not followed: the tree only follows those
 * resolving inside the folder, and rg has no such check.
 */
export function ripgrepArgs(request: FindInFilesRequest, folders: string[]): string[] {
	const args = [
		"--json",
		"--no-config",
		"--no-messages",
		"--hidden",
		"--no-ignore",
		"--sort=path",
		"--max-filesize=8M",
		// The tree scans 10 directory levels below the root; files sit one deeper.
		"--max-depth=11",
		request.caseSensitive ? "--case-sensitive" : "--ignore-case",
	];
	if (!request.regex) args.push("--fixed-strings");
	if (request.wholeWord) args.push("--word-regexp");
	for (const dir of IGNORE_DIRS) args.push(`--iglob=!${dir}/`);
	for (const glob of splitMask(request.mask)) args.push(`--iglob=${glob}`);
	args.push("--regexp", request.query, "--", ...folders);
	return args;
}

interface RgText {
	text?: string;
	bytes?: string;
}

interface RgMatch {
	type: string;
	data: {
		path: RgText;
		lines: RgText;
		line_number: number;
		submatches: { start: number; end: number }[];
	};
}

function decode(value: RgText): string | null {
	if (value.text !== undefined) return value.text;
	if (value.bytes !== undefined) {
		return new TextDecoder().decode(Buffer.from(value.bytes, "base64"));
	}
	return null;
}

/**
 * One rg `match` event as a row. rg reports byte offsets; the editor counts
 * UTF-16 units, so each offset is converted by decoding the bytes before it.
 */
export function toRow(event: RgMatch): FindInFilesMatch | null {
	const path = decode(event.data.path);
	const raw = decode(event.data.lines);
	if (path === null || raw === null) return null;
	const bytes = Buffer.from(raw, "utf8");
	const offset = (byte: number) => bytes.subarray(0, byte).toString("utf8").length;
	const full = raw.replace(/\r?\n$/, "");
	const hits = event.data.submatches.map(
		(sub) => [offset(sub.start), offset(sub.end)] as [number, number],
	);
	const column = hits[0]?.[0] ?? 0;

	let text = full;
	let shift = 0;
	if (full.length > MAX_LINE_CHARS) {
		shift = Math.max(0, column - CLIP_LEAD);
		text = full.slice(shift, shift + MAX_LINE_CHARS);
	}
	const ranges = hits
		.map(([start, end]) => [start - shift, Math.min(end - shift, text.length)] as [number, number])
		.filter(([start, end]) => start >= 0 && start < end);

	return { path, line: event.data.line_number, column, text, ranges };
}

/**
 * Runs one search. Never throws for a search-level problem (bad regex, missing
 * folder); that comes back as `error` for the modal to show.
 */
export async function findInFiles(
	request: FindInFilesRequest,
	rgPath: string | null = ripgrepPath,
): Promise<FindInFilesResult> {
	const ticket = ++latest;
	running?.kill();
	running = null;

	const empty: FindInFilesResult = { matches: [], truncated: false, error: null };
	if (!request.query) return empty;
	if (!rgPath) return { ...empty, error: "ripgrep is not available in this build" };

	// Realpaths, because the tree keys files by realpath and an open tab is
	// matched by path: a hit under a symlinked folder must name the same file.
	const folders: string[] = [];
	for (const folder of request.folders) {
		try {
			folders.push(await realpath(folder));
		} catch {
			// A folder deleted behind the app; the rest still search.
		}
	}
	if (folders.length === 0 || ticket !== latest) return empty;

	let proc: Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn([rgPath, ...ripgrepArgs(request, folders)], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		return { ...empty, error: `Cannot start ripgrep: ${error instanceof Error ? error.message : String(error)}` };
	}
	running = proc;

	const matches: FindInFilesMatch[] = [];
	const seen = new Set<string>();
	let truncated = false;
	const decoder = new TextDecoder();
	let pending = "";

	const take = (line: string): boolean => {
		if (!line.startsWith('{"type":"match"')) return true;
		const row = toRow(JSON.parse(line) as RgMatch);
		if (!row) return true;
		const key = `${row.path}\0${row.line}`;
		if (seen.has(key)) return true;
		seen.add(key);
		matches.push(row);
		if (matches.length < MAX_ROWS) return true;
		truncated = true;
		return false;
	};

	read: for await (const chunk of proc.stdout) {
		pending += decoder.decode(chunk, { stream: true });
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			if (!take(line)) {
				proc.kill();
				break read;
			}
			newline = pending.indexOf("\n");
		}
	}

	const code = await proc.exited;
	if (running === proc) running = null;
	if (ticket !== latest) return empty;

	// Exit 2 also covers "some file was unreadable"; with rows in hand that is
	// not worth an error banner, only an empty search is.
	if (code === 2 && matches.length === 0) {
		const stderr = (await new Response(proc.stderr).text()).trim();
		return { ...empty, error: stderr || "ripgrep failed" };
	}
	return { matches, truncated, error: null };
}
