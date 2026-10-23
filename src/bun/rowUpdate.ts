import type { SQL } from "bun";
import type { SqlDbType } from "../shared/types";
import { driverFor } from "./driver";

export interface RowChange {
	/** Values of the key columns as the grid last read them, before any edit. */
	keyValues: unknown[];
	changes: { column: string; value: unknown }[];
}

/**
 * One UPDATE per row, every edited column of that row in a single SET, so a
 * row with three edited cells is one statement rather than three.
 *
 * Parameters follow the text order: SET values first, then the key values.
 * MySQL's `?` is positional by appearance, so the order has to match the text.
 */
export function buildRowUpdate(
	dbType: SqlDbType,
	schema: string,
	table: string,
	keyColumns: string[],
	row: RowChange,
): { sql: string; params: unknown[] } {
	const driver = driverFor(dbType);
	const placeholder = (index: number) =>
		dbType === "mysql" ? "?" : `$${index + 1}`;
	const assignments = row.changes.map(
		(change, index) =>
			`${driver.quoteIdent(change.column)} = ${placeholder(index)}`,
	);
	const where = keyColumns.map(
		(name, index) =>
			`${driver.quoteIdent(name)} = ${placeholder(row.changes.length + index)}`,
	);
	const target = driver.qualify("", schema, table);
	return {
		sql: `UPDATE ${target} SET ${assignments.join(", ")} WHERE ${where.join(" AND ")}`,
		params: [...row.changes.map((change) => change.value), ...row.keyValues],
	};
}

/**
 * All or nothing: one failed row rolls back the rows before it, so the grid
 * never has to report which half of a commit landed.
 */
export async function applyRowUpdates(
	db: SQL,
	dbType: SqlDbType,
	schema: string,
	table: string,
	keyColumns: string[],
	rows: RowChange[],
): Promise<number> {
	const statements = rows
		.filter((row) => row.changes.length > 0)
		.map((row) => buildRowUpdate(dbType, schema, table, keyColumns, row));
	await db.begin(async (tx) => {
		for (const statement of statements) {
			await tx.unsafe(statement.sql, statement.params);
		}
	});
	return statements.length;
}
