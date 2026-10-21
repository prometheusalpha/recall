/**
 * Types for Find in Files: a ripgrep search over the opened SQL folders.
 */

export interface FindInFilesRequest {
	/** The opened folders. Nested ones are fine; duplicate hits are dropped. */
	folders: string[];
	query: string;
	/**
	 * File mask, JetBrains style: comma-separated globs, `!` excludes, braces
	 * group (`*.{sql,md}`). Empty or `*` means every file.
	 */
	mask: string;
	caseSensitive: boolean;
	regex: boolean;
	wholeWord: boolean;
}

/** One matching line. Several hits on the same line share a row. */
export interface FindInFilesMatch {
	path: string;
	/** 1-based. */
	line: number;
	/** 0-based UTF-16 column of the first hit on the full line, for the caret. */
	column: number;
	/** The line, possibly clipped around the first hit so a huge line stays drawable. */
	text: string;
	/** `[start, end)` UTF-16 offsets into `text`, one per hit still inside it. */
	ranges: [number, number][];
}

export interface FindInFilesResult {
	matches: FindInFilesMatch[];
	/** True when the row cap was hit and the search stopped early. */
	truncated: boolean;
	/** ripgrep's own message, e.g. a regex that does not parse. */
	error: string | null;
}
