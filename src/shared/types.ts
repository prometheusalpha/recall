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
	/**
	 * Database names this profile keeps out of the sidebar and out of Quick
	 * Open. A list of *hidden* names rather than of visible ones, so a server
	 * that grows a database shows it without the user visiting the dialog again.
	 * The profile's own `database` is never hidden: it is the one the connection
	 * tested and the sidebar opens on.
	 */
	hiddenDatabases: string[];
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
	/**
	 * The `WHERE` body of a partial index (Postgres `pg_index.indpred`); null
	 * for an index that keeps every row, which is all MySQL can build.
	 */
	condition: string | null;
	/** The statement that rebuilds this index, ready to copy. */
	ddl: string;
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

/**
 * One node of an execution plan, in the shape both dialects are normalised to.
 *
 * Engines disagree about names and about which numbers they report, so this is
 * the union of what Postgres and MySQL say: everything past the first three is
 * optional. Costs and row estimates stay *text* — Postgres reports a cost as
 * `startup..total`, and a single number here would have to round one end of
 * that range on its way through JSON.
 */
export interface ExplainPlanNode {
	id: string;
	/** Label for the node, e.g. `Seq Scan on users`. */
	title: string;
	/** The bare operator, e.g. `Seq Scan` or `eq_ref`; what decides its colour. */
	nodeType: string;
	relation?: string;
	index?: string;
	cost?: string;
	rows?: string;
	width?: string;
	details: string[];
	children: ExplainPlanNode[];
}

/** One statement's plan, already normalised by the driver that produced it. */
export interface ExplainPlan {
	/** The statement that was sent, so the panel can show what it asked for. */
	sql: string;
	/** The server's own answer — shown verbatim in the panel's raw view. */
	raw: unknown;
	nodes: ExplainPlanNode[];
}

/**
 * The answer to an EXPLAIN. A rejected plan is data, like every other database
 * error here, so the server's reason is shown where the plan would be.
 */
export interface ExplainResult {
	plan: ExplainPlan | null;
	error: BackendError | null;
}

/**
 * One table pinned in the sidebar, addressed by the coordinates the tree uses.
 */
export interface PinnedTable {
	connectionId: string;
	database: string;
	/** For MySQL this repeats `database`: it has no schema level below it. */
	schema: string;
	table: string;
}

/** Keys are connection ids. Values are the persisted configs, by id. */
export type ConnectionMap = Record<string, ConnectionConfig>;