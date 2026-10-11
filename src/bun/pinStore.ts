/**
 * Pinned sidebar tables in SQLite.
 *
 * A pin is one table, addressed by the same coordinates the tree navigates by:
 * connection, database, schema and table. Rows live in `recall.db` rather than
 * in the webview's storage so a pin survives a restart, and a cleared webview
 * cache cannot take the sidebar's contents with it — the pin list is backend
 * state, like the connections themselves.
 *
 * Insertion order is the rendering order: the sidebar shows pins in the order
 * they were added, not grouped by connection, so the row carries an explicit
 * `position`. A set of keys ordered by a timestamp would reorder pins added in
 * the same millisecond, and the sidebar must not shuffle on its own.
 *
 * Every mutation answers with {@link listPinnedTables}, so the renderer replaces
 * its whole list and the two sides cannot drift apart.
 */
import type { PinnedTable } from "../shared/types";
import { appDb } from "./appDb";

/** One row as SQLite hands it back. */
interface PinnedTableRow {
	connection_id: string;
	database: string;
	schema: string;
	table_name: string;
}

/**
 * Every pinned table, oldest pin first. `position` ties are broken by name so
 * the order is total: two pins can never swap places between two reads.
 */
export function listPinnedTables(): PinnedTable[] {
	const rows = appDb()
		.query(
			"SELECT connection_id, database, schema, table_name FROM pinned_tables ORDER BY position ASC, table_name ASC",
		)
		.all() as PinnedTableRow[];
	return rows.map((row) => ({
		connectionId: row.connection_id,
		database: row.database,
		schema: row.schema,
		table: row.table_name,
	}));
}

/**
 * Pins or unpins one table and returns the resulting list.
 *
 * Pinning takes the next `position` past the current maximum, all inside one
 * transaction so two concurrent pins cannot read the same maximum and claim the
 * same slot. `INSERT OR IGNORE` on the composite key makes pinning an
 * already-pinned table a no-op rather than an error — the renderer may toggle a
 * pin it believes is absent, and that must not fail. Unpinning deletes the
 * matching row; deleting a row that is not there is likewise not an error.
 */
export function setPinnedTable(
	input: PinnedTable & { pinned: boolean },
): PinnedTable[] {
	const db = appDb();
	const insert = db.query(
		"INSERT OR IGNORE INTO pinned_tables (connection_id, database, schema, table_name, position) VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM pinned_tables))",
	);
	const remove = db.query(
		"DELETE FROM pinned_tables WHERE connection_id = ? AND database = ? AND schema = ? AND table_name = ?",
	);
	const key = [input.connectionId, input.database, input.schema, input.table];
	db.transaction(() => {
		if (input.pinned) insert.run(...key);
		else remove.run(...key);
	})();
	return listPinnedTables();
}
