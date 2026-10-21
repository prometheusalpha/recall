/**
 * Schema and migrations for `recall.db`. Split from `./appDb` so a plain Bun
 * process — a test — can apply them to a scratch database: `./appDb` imports
 * Electrobun for the data folder and opens the user's real file.
 */
import type { Database } from "bun:sqlite";

/**
 * `options` holds the fields only one engine family has (Redis's `defaultDb`),
 * as JSON. The SQL columns predate it and stay as columns; a Redis row carries
 * neutral values in them. A new engine adds keys here instead of a migration.
 */
const CONNECTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS connections (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	db_type TEXT NOT NULL CHECK (db_type IN ('postgres', 'mysql', 'redis')),
	host TEXT NOT NULL,
	port INTEGER NOT NULL,
	username TEXT NOT NULL,
	database TEXT NOT NULL,
	default_schema TEXT NOT NULL,
	ssl INTEGER NOT NULL,
	url_params TEXT NOT NULL,
	connect_timeout_secs INTEGER NOT NULL,
	query_timeout_secs INTEGER NOT NULL,
	note TEXT NOT NULL,
	save_password INTEGER NOT NULL,
	show_system_schemas INTEGER NOT NULL,
	hidden_databases TEXT NOT NULL DEFAULT '[]',
	options TEXT NOT NULL DEFAULT '{}',
	position INTEGER NOT NULL
);`;

export const SCHEMA = `${CONNECTIONS_TABLE}

/*
 * One row per mnemonic bookmark. The mnemonic is the key, so there are at most
 * 36 of them and assigning one that is taken replaces it. \`line_hash\` is a
 * digest of the bookmarked line: a file edited above a bookmark shifts every
 * line below it, and the digest is what lets a jump find the line again.
 */
CREATE TABLE IF NOT EXISTS bookmarks (
	mnemonic TEXT PRIMARY KEY CHECK (mnemonic GLOB '[a-z0-9]'),
	path TEXT NOT NULL,
	line INTEGER NOT NULL,
	line_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bookmarks_path ON bookmarks(path);

/*
 * One row per pinned table. The composite key is the (connection, database,
 * schema, table) path the sidebar tree navigates by, so pinning the same table
 * twice is the same key twice and collapses to one row. \`position\` is the
 * order pins were added and is what the sidebar renders.
 */
CREATE TABLE IF NOT EXISTS pinned_tables (
	connection_id TEXT NOT NULL,
	database TEXT NOT NULL,
	schema TEXT NOT NULL,
	table_name TEXT NOT NULL,
	position INTEGER NOT NULL,
	PRIMARY KEY (connection_id, database, schema, table_name)
);
CREATE INDEX IF NOT EXISTS pinned_tables_position ON pinned_tables(position);
`;

/** Every column a pre-Redis file can hold, named so column order cannot matter. */
const LEGACY_COLUMNS = [
	"id", "name", "db_type", "host", "port", "username", "database",
	"default_schema", "ssl", "url_params", "connect_timeout_secs",
	"query_timeout_secs", "note", "save_password", "show_system_schemas",
	"hidden_databases", "position",
].join(", ");

/**
 * Columns added after a release, applied to files that already hold the table.
 * `CREATE TABLE IF NOT EXISTS` does nothing to an existing `connections` row
 * set, so a new column needs a step of its own — and `recall.db` is never
 * deleted, so every install predating the column arrives here with the old
 * shape. `PRAGMA` rather than a bare `ALTER` in a try/catch: a swallowed error
 * would leave the column missing and only surface much later, as a fresh
 * profile written with one field short.
 */
export function migrate(database: Database): void {
	const columns = database
		.query("PRAGMA table_info(connections)")
		.all() as { name: string }[];
	if (!columns.some((column) => column.name === "hidden_databases")) {
		database.run(
			"ALTER TABLE connections ADD COLUMN hidden_databases TEXT NOT NULL DEFAULT '[]'",
		);
	}
	allowRedis(database);
}

/**
 * SQLite cannot alter a CHECK constraint, so admitting `redis` means copying
 * the rows into a rebuilt table. One transaction: a failure part-way leaves the
 * old table and every profile in it untouched.
 */
function allowRedis(database: Database): void {
	const row = database
		.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connections'")
		.get() as { sql: string } | null;
	if (!row || row.sql.includes("'redis'")) return;
	database.transaction(() => {
		database.run("ALTER TABLE connections RENAME TO connections_legacy");
		database.run(CONNECTIONS_TABLE);
		database.run(
			`INSERT INTO connections (${LEGACY_COLUMNS}) SELECT ${LEGACY_COLUMNS} FROM connections_legacy`,
		);
		database.run("DROP TABLE connections_legacy");
	})();
}
