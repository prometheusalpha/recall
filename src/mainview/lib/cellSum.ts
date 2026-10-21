/**
 * Summing a selection of result-grid cells.
 *
 * The values are `unknown` because `StatementResult.rows` is `unknown[][]` — the
 * result travels over RPC as JSON, and `Bun.SQL` hands back Postgres/MySQL
 * `numeric`, `decimal` and `bigint` as STRINGS. The declared column type is not
 * reliable enough to gate on (MySQL never reports one, and a failed Postgres
 * probe falls back to "string"), so any string that parses to a finite number
 * counts, whatever the column type.
 */

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
	/** How many selected cells were skipped: null, undefined, NaN, Infinity, a non-numeric string, or anything else. */
	skipped: number;
}

/** The number a cell contributes, or null when it contributes nothing. */
function numericValue(value: unknown, columnType: string | undefined): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string") return null;
	const type = columnType?.toLowerCase();
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
 * Adds up every cell that is a number or a string parsing to one.
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