/**
 * Types for the "open folder" feature: a tree of .sql files on disk, each of
 * which can be bound to a datasource.
 */

/** One node of a folder scan. Directories carry `children`; files do not. */
export interface SqlFileNode {
	/** Absolute path. Unique within a scan. */
	path: string;
	/** Base name, used for display and for sorting. */
	name: string;
	isDir: boolean;
	children: SqlFileNode[];
}

/** The datasource a file runs against. Mirrors the reference app's binding. */
export interface FileDatasource {
	connectionId: string;
	database: string;
	/** Postgres only; empty for MySQL. */
	schema: string;
}

export interface SqlFileContent {
	content: string;
	/**
	 * Opaque version token (content hash). Passed back on write so a file edited
	 * outside the app is never silently overwritten.
	 */
	version: string;
}

export type SqlFileWriteResult =
	| { ok: true; version: string }
	| { ok: false; reason: "conflict" | "missing"; currentVersion: string | null };

/**
 * Outcome of a mutating file operation (create, rename, delete, copy/move).
 *
 * A failure is data, never an exception, because each one is an expected
 * outcome the tree has to report: a name already taken, a node that vanished
 * between the scan and the click, a name the filesystem would reject. Only a
 * transport failure throws.
 */
export type SqlFileOpResult =
	| { ok: true; path: string }
	| { ok: false; reason: "exists" | "missing" | "invalid"; message: string };

/** One entry a copy/move refused, alongside the ones that succeeded. */
export interface SqlFileOpFailure {
	path: string;
	message: string;
}

export interface SqlFileOpBatchResult {
	/** One entry per source that landed, in request order. */
	moved: { from: string; to: string }[];
	failures: SqlFileOpFailure[];
}