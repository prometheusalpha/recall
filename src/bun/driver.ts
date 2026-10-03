import type { SQL } from "bun";
import type {
	BackendError,
	ColumnInfo,
	ConnectionConfig,
	DatabaseConnectionInfo,
	DatabaseType,
	ForeignKeyInfo,
	IndexInfo,
	TableInfo,
	TriggerInfo,
} from "../shared/types";
import { postgresDriver } from "./drivers/postgres";
import { mysqlDriver } from "./drivers/mysql";

/** Constructor options accepted by `new SQL(...)`. */
export type SQLOptions = SQL.Options;

/**
 * Everything the Bun side knows about a specific dialect. Quoting, identifier
 * qualification and metadata SQL live here and nowhere else — no other module
 * may branch on `dbType` or spell out `information_schema`.
 */
export interface Driver {
	readonly dbType: DatabaseType;
	/** Build the Bun.SQL constructor options from a ConnectionConfig. */
	buildOptions(cfg: ConnectionConfig): SQLOptions;
	/** Cheap liveness + version probe. Runs `SELECT version()`-equivalent. */
	ping(db: SQL): Promise<DatabaseConnectionInfo>;
	/** Normalized quote character for identifiers. */
	quoteIdent(name: string): string;
	/** Fully-qualified, quoted table reference. */
	qualify(database: string, schema: string, table: string): string;
	/**
	 * Whether a session is pinned to one database. Postgres binds its socket to
	 * a database at connect time and cannot reach another one, so a request
	 * naming a different database needs its own connection; MySQL qualifies
	 * cross-database and answers any database from the one session.
	 */
	readonly databaseScoped: boolean;
	/**
	 * Postgres only; MySQL returns []. `cfg` is passed because the reference
	 * app's schema list honours `ConnectionConfig.showSystemSchemas`.
	 */
	listSchemas(db: SQL, cfg: ConnectionConfig, database: string): Promise<string[]>;
	/** Top-level containers shown in the connection tree (databases). */
	listDatabases(db: SQL, filter: string): Promise<
		Array<{ name: string; comment: string | null }>
	>;
	listTables(
		db: SQL,
		database: string,
		schema: string,
		filter: string,
	): Promise<TableInfo[]>;
	listColumns(
		db: SQL,
		database: string,
		schema: string,
		table: string,
	): Promise<ColumnInfo[]>;
	/** Indexes, primary keys and unique constraints on a table. */
	listIndexes(
		db: SQL,
		database: string,
		schema: string,
		table: string,
	): Promise<IndexInfo[]>;
	/** Triggers defined on a table, with their timing, event and body. */
	listTriggers(
		db: SQL,
		database: string,
		schema: string,
		table: string,
	): Promise<TriggerInfo[]>;
	/** Foreign-key constraints declared on a table. */
	listForeignKeys(
		db: SQL,
		database: string,
		schema: string,
		table: string,
	): Promise<ForeignKeyInfo[]>;
	tableDdl(
		db: SQL,
		database: string,
		schema: string,
		table: string,
	): Promise<string>;
}

export const DRIVERS: Record<DatabaseType, Driver> = {
	postgres: postgresDriver,
	mysql: mysqlDriver,
};

export function driverFor(dbType: DatabaseType): Driver {
	const driver = DRIVERS[dbType];
	if (!driver) {
		throw new Error(
			`Unsupported database type "${String(dbType)}". Expected one of: ${Object.keys(
				DRIVERS,
			).join(", ")}.`,
		);
	}
	return driver;
}

// ---------------------------------------------------------------------------
// URL parameter parsing (shared: `ConnectionConfig.urlParams` is a raw query
// string such as `sslmode=verify-full` or `charset=utf8mb4`).
// ---------------------------------------------------------------------------

/** Parse a raw query string into ordered `[key, value]` pairs. */
export function parseUrlParams(raw: string): Array<[string, string]> {
	const trimmed = raw.trim().replace(/^[?&]+/, "");
	if (!trimmed) return [];
	return trimmed.split("&").flatMap((pair) => {
		if (!pair) return [];
		const eq = pair.indexOf("=");
		if (eq === -1) return [[decodeParam(pair), ""] as [string, string]];
		return [
			[
				decodeParam(pair.slice(0, eq)),
				decodeParam(pair.slice(eq + 1)),
			] as [string, string],
		];
	});
}

function decodeParam(value: string): string {
	try {
		return decodeURIComponent(value.replace(/\+/g, " "));
	} catch {
		return value;
	}
}

/** Same as {@link parseUrlParams} but collapsed to a plain record. */
export function urlParamsToRecord(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of parseUrlParams(raw)) out[key] = value;
	return out;
}

// ---------------------------------------------------------------------------
// Value normalization — the RPC transport is JSON, so every cell the grid
// receives has to survive `JSON.stringify`.
// ---------------------------------------------------------------------------

/**
 * Convert a driver value into something JSON-safe: BigInt and Uint8Array become
 * strings, Date becomes an ISO string, Buffers become base64.
 */
export function toJsonSafe(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	switch (typeof value) {
		case "bigint":
			return value.toString();
		case "function":
		case "symbol":
			return String(value);
		case "object":
			break;
		default:
			return value;
	}
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value.toISOString();
	}
	if (value instanceof Uint8Array) {
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
			"base64",
		);
	}
	if (Array.isArray(value)) return value.map(toJsonSafe);
	if (ArrayBuffer.isView(value)) {
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
			"base64",
		);
	}
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		out[key] = toJsonSafe(entry);
	}
	return out;
}

/** Best-effort JS type name for a result column, derived from its values. */
export function columnTypeName(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (value instanceof Date) return "date";
	if (value instanceof Uint8Array) return "bytes";
	switch (typeof value) {
		case "bigint":
			return "bigint";
		case "boolean":
			return "boolean";
		case "number":
			return "number";
		case "string":
			return "string";
		case "object":
			return Array.isArray(value) ? "array" : "json";
		default:
			return typeof value;
	}
}

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

/**
 * Turn anything thrown by `Bun.SQL` into the shared `BackendError` shape.
 * `sql` is used to turn a Postgres character offset into a line/column.
 */
export function normalizeBackendError(
	error: unknown,
	sql?: string,
): BackendError {
	const raw = (error ?? {}) as Record<string, unknown>;
	const code =
		typeof raw.code === "string" || typeof raw.code === "number"
			? String(raw.code)
			: "ERR_UNKNOWN";
	const message =
		error instanceof Error
			? error.message
			: typeof raw.message === "string"
				? raw.message
				: String(error);

	const detailParts: string[] = [];
	for (const key of ["detail", "hint", "sqlState", "where", "schema", "table"]) {
		const value = raw[key];
		if (typeof value === "string" && value.length > 0) {
			detailParts.push(value);
		}
	}

	const out: BackendError = {
		code,
		message,
		detail: detailParts.length ? detailParts.join(" · ") : undefined,
	};

	const position = toPosition(raw.position ?? raw.pos, sql);
	if (position) out.errorPosition = position;
	if (out.detail === undefined) delete out.detail;

	return out;
}

/** Postgres reports `position` as a 1-based character offset into the query. */
function toPosition(
	raw: unknown,
	sql: string | undefined,
): { line: number; column: number } | undefined {
	const offset = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
	if (!Number.isFinite(offset) || offset < 1) return undefined;
	if (!sql || sql.length === 0) return { line: 1, column: offset };
	const slice = sql.slice(0, offset - 1);
	const line = slice.split("\n").length;
	const lastBreak = slice.lastIndexOf("\n");
	return { line, column: offset - lastBreak };
}

/** An Error carrying a normalized {@link BackendError} for RPC transport. */
export class BackendFailure extends Error {
	readonly backendError: BackendError;

	constructor(backendError: BackendError) {
		super(backendError.message);
		this.name = "BackendFailure";
		this.backendError = backendError;
	}
}

/** Wrap any thrown value as a {@link BackendFailure}. */
export function backendFailure(error: unknown, sql?: string): BackendFailure {
	if (error instanceof BackendFailure) return error;
	return new BackendFailure(normalizeBackendError(error, sql));
}

// ---------------------------------------------------------------------------
// Statement splitting
// ---------------------------------------------------------------------------

/**
 * Split a SQL batch into individual statements.
 *
 * Understands, per dialect: `--` line comments, `/* *\/` block comments,
 * single-quoted strings with `''` escapes, double-quoted and backtick quoted
 * identifiers, MySQL `#` line comments and MySQL backslash escapes, and
 * Postgres dollar quoting (`$$ … $$` / `$tag$ … $tag$`).
 *
 * A `--` or `/*` inside a string literal never splits, and a `;` inside a
 * dollar-quoted body never splits.
 */
export function splitStatements(

	sql: string,
	dbType: DatabaseType,
): string[] {
	const isPostgres = dbType === "postgres";
	const out: string[] = [];
	const length = sql.length;
	let index = 0;
	let start = 0;

	const flush = (end: number) => {
		const chunk = sql.slice(start, end).trim();
		if (chunk.length > 0) out.push(chunk);
	};

	while (index < length) {
		const char = sql[index];

		if (char === "-" && sql[index + 1] === "-") {
			index += 2;
			while (index < length && sql[index] !== "\n") index++;
			continue;
		}
		if (isPostgres === false && char === "#") {
			index += 1;
			while (index < length && sql[index] !== "\n") index++;
			continue;
		}
		if (char === "/" && sql[index + 1] === "*") {
			index += 2;
			while (index < length && !(sql[index] === "*" && sql[index + 1] === "/")) {
				index++;
			}
			index = Math.min(length, index + 2);
			continue;
		}
		if (char === "'") {
			index = skipQuoted(sql, index, "'", !isPostgres);
			continue;
		}
		if (char === '"') {
			index = skipQuoted(sql, index, '"', !isPostgres);
			continue;
		}
		if (char === "`") {
			index = skipQuoted(sql, index, "`", false);
			continue;
		}
		if (isPostgres && char === "$") {
			const tag = matchDollarTag(sql, index);
			if (tag !== null) {
				const close = sql.indexOf(tag, index + tag.length);
				index = close === -1 ? length : close + tag.length;
				continue;
			}
		}
		if (char === ";") {
			flush(index);
			index++;
			start = index;
			continue;
		}
		index++;

	}
	flush(length);

	return out;
}

/**
 * Advance past a quoted region that opens at `start` (which points at the
 * opening quote). Handles the doubled-quote escape always, and the backslash
 * escape for dialects that enable it (MySQL, by default).
 */
function skipQuoted(
	sql: string,
	start: number,
	quote: string,
	backslashEscapes: boolean,
): number {
	const length = sql.length;
	let index = start + 1;
	while (index < length) {
		const char = sql[index];
		if (backslashEscapes && char === "\\") {
			index += 2;
			continue;
		}
		if (char === quote) {
			if (sql[index + 1] === quote) {
				index += 2;
				continue;
			}
			return index + 1;
		}
		index++;
	}
	return length;
}

/**
 * Match a Postgres dollar-quote opener at `start`, e.g. `$$` or `$body$`.
 * Returns the full delimiter (including both `$`), or null when the `$` is a
 * positional parameter (`$1`) or an ordinary operator.
 */
function matchDollarTag(sql: string, start: number): string | null {
	let index = start + 1;
	if (index >= sql.length) return null;
	// The empty tag `$$` is legal and is by far the most common form.
	if (sql[index] === "$") return "$$";
	if (!/[A-Za-z0-9_]/.test(sql[index])) return null;
	// A leading digit means a positional parameter, not a dollar-quote tag.
	if (/[0-9]/.test(sql[index])) return null;
	while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index])) index++;
	if (sql[index] !== "$") return null;
	return sql.slice(start, index + 1);
}

// ---------------------------------------------------------------------------
// Column discovery
// ---------------------------------------------------------------------------

/**
 * Wrap a read statement so it can be run for its column names only.
 *
 * The one-row seed forces exactly one output row of NULLs carrying the inner
 * query's column names. A plain `LIMIT 0` would return no rows at all, and
 * `Bun.SQL` exposes rows but no result metadata, so the keys of a returned row
 * are the only portable source of column names.
 */
export function wrapForColumnProbe(sql: string): string {
	const body = sql.trim().replace(/;\s*$/, "");
	return (
		`SELECT recall_column_probe.* FROM (SELECT 1 AS recall_seed) AS recall_seed_row ` +
		`LEFT JOIN (${body}) AS recall_column_probe ON true`
	);
}

const READ_STATEMENT_RE =
	/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*(select|with|values|table|explain|show|describe|desc)\b/i;

/** True for statements that produce a result set (so columns are meaningful). */
export function isReadStatement(sql: string): boolean {
	return READ_STATEMENT_RE.test(sql);
}

/**
 * Best-effort column names for a statement that returned no rows. Returns `[]`
 * whenever the statement is not a read or the server rejects the probe — it
 * never throws, so a probe failure cannot fail the query it describes.
 */
export async function probeStatementColumns(
	db: SQL,
	sql: string,
): Promise<string[]> {
	if (!isReadStatement(sql)) return [];
	try {
		const rows = (await db.unsafe(wrapForColumnProbe(sql))) as unknown;
		if (!Array.isArray(rows) || rows.length === 0) return [];
		const first = rows[0];
		if (first === null || typeof first !== "object" || Array.isArray(first)) {
			return [];
		}
		return Object.keys(first as Record<string, unknown>);
	} catch {
		return [];
	}
}