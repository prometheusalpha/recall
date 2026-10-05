/**
 * Summing a selection of result-grid cells.
 *
 * The values are `unknown` because `StatementResult.rows` is `unknown[][]` — the
 * result travels over RPC as JSON, so a Postgres `numeric` or a Postgres
 * `bigint` can arrive as a string and a `jsonb` cell as an object. Everything is
 * therefore taken at face value and only a real finite JS number contributes;
 * nothing is coerced, so a text column that happens to read "42" is reported as
 * skipped rather than quietly becoming arithmetic on the total.
 */

export interface CellSumResult {
	/** Sum of every finite number in the selection. 0 when there are none. */
	sum: number;
	/** How many cells contributed a number. */
	count: number;
	/** How many selected cells were skipped: null, undefined, NaN, Infinity, bigint, boolean, object, or anything else non-numeric. */
	skipped: number;
}

/**
 * Adds up the numeric cells. `bigint` in particular is rejected rather than
 * widened: a bigint cannot be added to a number without an explicit conversion,
 * and one giant value would poison the total anyway.
 */
export function sumCells(values: readonly unknown[]): CellSumResult {
	let sum = 0;
	let count = 0;
	let skipped = 0;
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) {
			sum += value;
			count++;
		} else {
			skipped++;
		}
	}
	return { sum, count, skipped };
}