/**
 * One `INSERT` statement for a result-grid row.
 *
 * The grid holds a page of rows that already crossed the driver's JSON-safe
 * conversion, so every value here is a string, number, boolean, null or a
 * plain object — a `BigInt` is a string by the time it arrives, and a value
 * the driver "forked" (a date, an instant, a numeric too large for a float) is
 * quoted as its JSON-safe text, never re-parsed from the grid's display
 * formatting. What the user copies is therefore the row the database returned,
 * not the row the grid paints: a hidden column is still inserted, because
 * omitting it would silently change which row the statement writes.
 *
 * Identifiers follow the connection's dialect — backticks for MySQL, double
 * quotes otherwise, with an embedded quote doubled. String literals double the
 * apostrophe, and MySQL additionally escapes the backslash because backslash
 * escapes are live there; Postgres leaves backslashes alone
 * (`standard_conforming_strings` is on). The literal's declared type, not the
 * JavaScript value, decides whether a numeric-looking string is written bare:
 * a string in an `int` column stays unquoted so it reads as a number to the
 * server, while the same text in a `text` column stays quoted.
 */
import type { SqlDbType } from "../../shared/types";

export interface InsertStatementInput {
	dbType: SqlDbType;
	database: string;
	schema: string;
	table: string;
	/** Result column names, in render order. */
	columns: string[];
	/** Declared types, parallel to `columns`; drives literal formatting. */
	columnTypes: string[];
	/** One result row: JSON-safe values exactly as the driver delivered them. */
	row: unknown[];
}

/**
 * Type-name prefixes whose column holds a number, so a string value that reads
 * as one is written bare. Compared against the leading run of letters, which
 * strips a length or precision (`numeric(10,2)` -> `numeric`).
 */
const NUMERIC_TYPE_PREFIXES: Record<string, true> = {
	int: true,
	integer: true,
	bigint: true,
	smallint: true,
	tinyint: true,
	mediumint: true,
	numeric: true,
	decimal: true,
	dec: true,
	real: true,
	double: true,
	float: true,
	money: true,
	serial: true,
	bigserial: true,
	fixed: true,
};

/** A string that is an exact number literal; anything else is text. */
const NUMERIC_LITERAL = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/** Identifier quote with the embedded quote doubled. */
function quoteIdentifier(name: string, dbType: SqlDbType): string {
	const quote = dbType === "mysql" ? "`" : "\"";
	return quote + name.split(quote).join(quote + quote) + quote;
}

/** Single-quoted literal; MySQL also escapes the backslash it treats as live. */
function quoteStringLiteral(value: string, dbType: SqlDbType): string {
	let escaped = value.replace(/'/g, "''");
	if (dbType === "mysql") escaped = escaped.replace(/\\/g, "\\\\");
	return `'${escaped}'`;
}

/**
 * The table, qualified per dialect. Postgres qualifies with its schema;
 * MySQL has no schema dimension, so its "schema" field carries the database
 * and is the qualifier, falling back to `database` when it is empty.
 */
function qualifyTarget(input: InsertStatementInput): string {
	const table = quoteIdentifier(input.table, input.dbType);
	const qualifier =
		input.dbType === "mysql"
			? input.schema !== ""
				? input.schema
				: input.database
			: input.schema;
	return qualifier !== ""
		? `${quoteIdentifier(qualifier, input.dbType)}.${table}`
		: table;
}

/**
 * One value as a SQL literal. A `Uint8Array` reaches the renderer as the
 * driver's opaque text, so it is quoted as `String(value)` — the bytes are
 * already base64 or hex by then, and this module must not guess which.
 */
function literal(
	value: unknown,
	columnType: string | undefined,
	dbType: SqlDbType,
): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (typeof value === "string") {
		// The leading run of letters strips a length or precision, so
		// `numeric(10,2)` is judged by `numeric`.
		const word = /^[a-z]+/.exec((columnType ?? "").toLowerCase())?.[0];
		if (
			word !== undefined &&
			NUMERIC_TYPE_PREFIXES[word] === true &&
			NUMERIC_LITERAL.test(value)
		) {
			return value;
		}
		return quoteStringLiteral(value, dbType);
	}
	if (typeof value === "object") {
		if (value instanceof Uint8Array) {
			return quoteStringLiteral(String(value), dbType);
		}
		const json = JSON.stringify(value);
		if (json === undefined) return quoteStringLiteral(String(value), dbType);
		return quoteStringLiteral(json, dbType);
	}
	return quoteStringLiteral(String(value), dbType);
}

/** One `INSERT INTO ... VALUES (...)` statement for a single row, `;`-terminated. */
export function buildInsertStatement(input: InsertStatementInput): string {
	const target = qualifyTarget(input);
	const columns = input.columns
		.map((name) => quoteIdentifier(name, input.dbType))
		.join(", ");
	const values = input.columns
		.map((_, index) =>
			literal(input.row[index], input.columnTypes[index], input.dbType),
		)
		.join(", ");
	return `INSERT INTO ${target} (${columns}) VALUES (${values});`;
}
