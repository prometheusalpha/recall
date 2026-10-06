/**
 * Summing a selection of result-grid cells.
 *
 * The values are `unknown` because `StatementResult.rows` is `unknown[][]` — the
 * result travels over RPC as JSON. That matters: `Bun.SQL` hands back every
 * Postgres `numeric`, `bigint` and `money` as a STRING (verified against a real
 * server), so summing on `typeof value === "number"` alone reported every such
 * column as skipped and showed `Sum 0` over a column of perfectly good
 * numbers. The declared column type is therefore part of the input: a string
 * only counts when the server said the column is numeric.
 *
 * Nothing else is coerced. A `text` column that happens to read "42" stays
 * skipped rather than quietly becoming arithmetic on the total.
 */

/** SQL type names a server may report for a numeric column. */
const NUMERIC_COLUMN_TYPES: Record<string, true> = {
	// Postgres, by declared name and by pg_typeof OID alias.
	smallint: true,
	integer: true,
	bigint: true,
	decimal: true,
	numeric: true,
	real: true,
	"double precision": true,
	float4: true,
	float8: true,
	int2: true,
	int4: true,
	int8: true,
	smallserial: true,
	serial: true,
	bigserial: true,
	money: true,
	smallmoney: true,
	// MySQL.
	tinyint: true,
	mediumint: true,
	double: true,
	float: true,
};

/** One selected cell: the raw value plus the type the server declared. */
export interface SumCell {
	value: unknown;
	columnType?: string;
}

export interface CellSumResult {
	/** Sum of every finite number in the selection. 0 when there are none. */
	sum: number;
	/** How many cells contributed a number. */
	count: number;
	/** How many selected cells were skipped: null, undefined, NaN, Infinity, a non-numeric column, or anything else. */
	skipped: number;
}

/** The number a cell contributes, or null when it contributes nothing. */
function numericValue(value: unknown, columnType: string | undefined): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string" || columnType === undefined) return null;
	const type = columnType.toLowerCase();
	if (NUMERIC_COLUMN_TYPES[type] !== true) return null;
	// Postgres renders `money` in the session's currency, so the wire value is
	// `"$5.00"`. Only the surrounding decoration is stripped; `Number` then reads
	// the digits, sign and decimal point that remain.
	const text = type === "money" || type === "smallmoney"
		? value.replace(/^[^\d.+-]+/, "").replace(/[^\d]+$/, "")
		: value;
	if (text.trim() === "") return null;
	// `Number("NaN")` and `Number("Infinity")` both parse, so finiteness is the
	// only test that keeps a Postgres `numeric` NaN out of the total.
	const parsed = Number(text);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Adds up the numeric cells. A numeric column whose value arrived as a string is
 * parsed; a string under any other column type is skipped, not coerced.
 */
export function sumCells(cells: readonly SumCell[]): CellSumResult {
	let sum = 0;
	let count = 0;
	let skipped = 0;
	for (const cell of cells) {
		const value = numericValue(cell.value, cell.columnType);
		if (value === null) {
			skipped++;
		} else {
			sum += value;
			count++;
		}
	}
	return { sum, count, skipped };
}