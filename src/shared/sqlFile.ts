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