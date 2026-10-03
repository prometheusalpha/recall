/**
 * Types for mnemonic bookmarks: a single character that points at a line of a
 * `.sql` file, kept in the app's own database rather than in the file.
 */

/** One stored bookmark, as both sides see it. */
export interface Bookmark {
	/** A single lowercase letter or digit; the primary key, so at most 36 exist. */
	mnemonic: string;
	/** Absolute path of the `.sql` file the line belongs to. */
	path: string;
	/** One-based line number. */
	line: number;
	/** Digest of the bookmarked line, used to re-anchor it after edits. */
	lineHash: string;
}