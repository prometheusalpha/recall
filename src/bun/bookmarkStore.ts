/**
 * Mnemonic bookmarks in SQLite.
 *
 * A bookmark is one character — `a` to `z` or `0` to `9` — bound to a line of
 * a `.sql` file. The character is the primary key, so there are at most 36 of
 * them and assigning one that is taken replaces it rather than failing.
 *
 * Nothing is written into the `.sql` file: the file stays exactly as the user
 * wrote it, and a bookmark lives only as long as the file it points at. Rows
 * whose file has since been deleted are dropped whenever the list is read, so
 * a bookmark never survives its file.
 *
 * A line number alone is not enough. Inserting a line at the top of a file
 * shifts every line below it, and a bookmark would silently end up on the wrong
 * statement. Each row therefore also stores a digest of the line it points at;
 * a jump hands the file's text to {@link resolveBookmark}, which finds the line
 * again when the number has drifted.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { Bookmark } from "../shared/bookmark";
import { appDb } from "./appDb";

/** One row as SQLite hands it back. */
interface BookmarkRow {
	mnemonic: string;
	path: string;
	line: number;
	line_hash: string;
}

/** Mnemonics are one lowercase letter or digit; the table's CHECK enforces it. */
export function isMnemonic(value: string): boolean {
	return /^[a-z0-9]$/.test(value);
}

/**
 * Digest of a line's text, trimmed of surrounding whitespace so that
 * re-indenting a line does not count as the bookmark having drifted.
 */
function lineHashFor(text: string): string {
	return createHash("sha256").update(text.trim(), "utf8").digest("hex").slice(0, 16);
}

/**
 * Forgets bookmarks whose file is gone. Called from the read paths rather than
 * from a filesystem watcher: the app does not own the folder the `.sql` files
 * live in, so a delete is only ever noticed when something asks for the list.
 */
function purgeMissingFiles(): void {
	const db = appDb();
	const rows = db.query("SELECT mnemonic, path FROM bookmarks").all() as {
		mnemonic: string;
		path: string;
	}[];
	const drop = db.query("DELETE FROM bookmarks WHERE mnemonic = ?");
	for (const row of rows) {
		if (!existsSync(row.path)) drop.run(row.mnemonic);
	}
}

/** Every stored bookmark, ordered by mnemonic so the list reads alphabetically. */
export function listBookmarks(): Bookmark[] {
	purgeMissingFiles();
	const rows = appDb()
		.query("SELECT * FROM bookmarks ORDER BY mnemonic")
		.all() as BookmarkRow[];
	return rows.map((row) => ({
		mnemonic: row.mnemonic,
		path: row.path,
		line: row.line,
		lineHash: row.line_hash,
	}));
}

/**
 * Binds `mnemonic` to a line of `path`. `lineText` is the line itself, sent by
 * the renderer because only it has the editor's text; the digest is computed
 * here so there is exactly one hashing implementation.
 *
 * A mnemonic already in use is replaced, and so is the row for the same file
 * and line — one line carries at most one bookmark.
 */
export function saveBookmark(input: {
	mnemonic: string;
	path: string;
	line: number;
	lineText: string;
}): Bookmark {
	if (!isMnemonic(input.mnemonic)) {
		throw new Error(`Not a bookmark mnemonic: ${input.mnemonic}`);
	}
	const line = Math.max(1, Math.floor(input.line));
	const lineHash = lineHashFor(input.lineText);
	const db = appDb();
	db.run(
		"DELETE FROM bookmarks WHERE path = ? AND line = ? AND mnemonic <> ?",
		[input.path, line, input.mnemonic],
	);
	db.run(
		"INSERT OR REPLACE INTO bookmarks (mnemonic, path, line, line_hash) VALUES (?, ?, ?, ?)",
		[input.mnemonic, input.path, line, lineHash],
	);
	return { mnemonic: input.mnemonic, path: input.path, line, lineHash };
}

/** Drops one bookmark. A mnemonic that is not set is not an error. */
export function clearBookmark(mnemonic: string): void {
	if (!isMnemonic(mnemonic)) return;
	appDb().run("DELETE FROM bookmarks WHERE mnemonic = ?", [mnemonic]);
}

/**
 * Re-anchors a bookmark against the current text of its file.
 *
 * The recorded line wins outright when its digest still matches. Otherwise the
 * same digest is looked for across the file and the closest occurrence wins,
 * which is the line a reader would pick: an edit that moved the bookmark left a
 * short distance of identical context behind it. A digest that appears nowhere
 * means the bookmarked line itself was edited, so the line number stands and
 * only the digest is refreshed.
 *
 * Returns null when the mnemonic is unset or its file no longer exists; a row
 * whose file is gone is deleted rather than reported, so a jump and a listing
 * agree on what exists.
 */
export function resolveBookmark(mnemonic: string, text: string): Bookmark | null {
	if (!isMnemonic(mnemonic)) return null;
	const db = appDb();
	const row = db
		.query("SELECT * FROM bookmarks WHERE mnemonic = ?")
		.get(mnemonic) as BookmarkRow | null;
	if (!row) return null;
	if (!existsSync(row.path)) {
		db.run("DELETE FROM bookmarks WHERE mnemonic = ?", [mnemonic]);
		return null;
	}

	const lines = text.split("\n");
	// One-based in, one-based out; a bookmark past the end of the file can only
	// mean the file shrank, and the last line is the closest thing to it.
	const recorded = Math.min(Math.max(row.line, 1), Math.max(lines.length, 1));
	if (lineHashFor(lines[recorded - 1] ?? "") === row.line_hash) {
		return {
			mnemonic: row.mnemonic,
			path: row.path,
			line: recorded,
			lineHash: row.line_hash,
		};
	}

	let best: number | null = null;
	for (let index = 0; index < lines.length; index += 1) {
		if (lineHashFor(lines[index] ?? "") !== row.line_hash) continue;
		if (best === null || Math.abs(index + 1 - recorded) < Math.abs(best - recorded)) {
			best = index + 1;
		}
	}

	const line = best ?? recorded;
	const lineHash = lineHashFor(lines[line - 1] ?? "");
	if (line !== row.line || lineHash !== row.line_hash) {
		db.run("UPDATE bookmarks SET line = ?, line_hash = ? WHERE mnemonic = ?", [
			line,
			lineHash,
			mnemonic,
		]);
	}
	return { mnemonic: row.mnemonic, path: row.path, line, lineHash };
}