/**
 * Types shared between the Bun main process and the Vue renderer.
 * This module emits no runtime code and is imported by both sides.
 */

export type DatabaseType = "postgres" | "mysql";

export interface ConnectionConfig {
	id: string;
	name: string;
	dbType: DatabaseType;
	host: string;
	port: number;
	username: string;
	password: string;
	database: string;
	/** Postgres only. Empty for MySQL (databases are the top-level container). */
	defaultSchema: string;
	ssl: boolean;
	/** Raw query string appended to the driver URL, e.g. `sslmode=verify-full`. */
	urlParams: string;
	connectTimeoutSecs: number;
	queryTimeoutSecs: number;
	/** Free-form user note about the connection; mirrors the reference `note`. */
	note: string;
	/** Keep the password in the session cache; mirrors `save_password`. */
	savePassword: boolean;
	/** Postgres only: list `pg_*`/`information_schema`; mirrors `show_system_schemas`. */
	showSystemSchemas: boolean;
}

/**
 * A stored profile: a `ConnectionConfig` without its password, which lives in
 * the OS keychain (`src/bun/credentialStore.ts`) rather than on disk.
 */
export type ConnectionProfile = Omit<ConnectionConfig, "password">;

export interface DatabaseInfo {
	name: string;
	comment: string | null;
}

export interface TableInfo {
	name: string;
	type: string;
	comment: string | null;
	/** Estimated row count; null when the driver does not report it cheaply. */
	rowCount: number | null;
}

export interface ColumnInfo {
	name: string;
	dataType: string;
	isNullable: boolean;
	isPrimaryKey: boolean;
	defaultValue: string | null;
	comment: string | null;
}

/** One index (or primary key / unique constraint) on a table. */
export interface IndexInfo {
	name: string;
	/** Key columns in index order, e.g. ["public_id"]. */
	columns: string[];
	isUnique: boolean;
	isPrimary: boolean;
	/** "btree" | "hash" | … ; null when the server does not report one. */
	method: string | null;
}

/** One foreign-key constraint on a table. */
export interface ForeignKeyInfo {
	name: string;
	/** Referencing columns, in constraint order. */
	columns: string[];
	/** The table on the other end, schema-qualified only if it differs. */
	referencedTable: string;
	referencedColumns: string[];
	/** "CASCADE" | "SET NULL" | … ; null when unspecified. */
	onUpdate: string | null;
	onDelete: string | null;
}

/** One trigger on a table. */
export interface TriggerInfo {
	name: string;
	/** "BEFORE" | "AFTER" | "INSTEAD OF" for Postgres; MySQL has no timing. */
	timing: string | null;
	/** "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE" … ; null when unreported. */
	event: string | null;
	/** The body the server reports, may be multi-line. */
	statement: string;
}

export interface DatabaseConnectionInfo {
	productName: string;
	productVersion: string;
	currentDatabase: string | null;
}

export interface ConnectionTestResult {
	ok: boolean;
	message: string;
	databaseInfo: DatabaseConnectionInfo | null;
	/**
	 * Databases reachable with this profile, so the form can offer a choice
	 * instead of asking the user to type a name that may not exist. Empty when
	 * the listing failed; a failed listing does not fail the connection.
	 */
	databases: string[];
	/** Schemas for PostgreSQL; empty for MySQL, where the database is the schema. */
	schemas: string[];
}

export interface SqlErrorPosition {
	line: number;
	column: number;
}

export interface BackendError {
	code: string;
	message: string;
	detail?: string;
	errorPosition?: SqlErrorPosition;
}

/**
 * One statement's outcome. `dbx` returns a single QueryResult for a batch; we
 * return one entry per split statement so the grid can show statement index.
 */
export interface StatementResult {
	/** Zero-based index of this statement inside the submitted batch. */
	statementIndex: number;
	sql: string;
	columns: string[];
	columnTypes: string[];
	/** Positional rows; parallel to `columns`. Values are JSON-safe. */
	rows: unknown[][];
	affectedRows: number;
	executionTimeMs: number;
	/** True when the row cap was hit and rows were dropped. */
	truncated: boolean;
	error: BackendError | null;
}

export interface ExecuteResult {
	statements: StatementResult[];
	totalExecutionTimeMs: number;
}

/** Keys are connection ids. Values are the persisted configs, by id. */
export type ConnectionMap = Record<string, ConnectionConfig>;