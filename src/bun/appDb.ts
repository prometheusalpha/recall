/**
 * The app's SQLite file.
 *
 * One `recall.db` under the OS data folder holds every piece of state the
 * backend owns; the handle is opened on first use and kept for the lifetime of
 * the Bun process. Tables live here rather than in their feature modules
 * because `CREATE TABLE IF NOT EXISTS` is cheap and this is the only place
 * that knows the file's location.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Utils from "electrobun/main/utils";

/**
 * Folder name under the OS data dir. Electrobun exposes no path helper for
 * the bundle identifier, so this is `app.identifier` from
 * `electrobun.config.ts` — keep the two in step.
 */
const APP_DIR = "app.recall.desktop";
const DB_FILE = "recall.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	db_type TEXT NOT NULL CHECK (db_type IN ('postgres', 'mysql')),
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
	position INTEGER NOT NULL
);

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
`;

let db: Database | null = null;

/**
 * Columns added after a release, applied to files that already hold the table.
 * `CREATE TABLE IF NOT EXISTS` does nothing to an existing `connections` row
 * set, so a new column needs a step of its own — and `recall.db` is never
 * deleted, so every install predating the column arrives here with the old
 * shape. `PRAGMA` rather than a bare `ALTER` in a try/catch: a swallowed error
 * would leave the column missing and only surface much later, as a fresh
 * profile written with one field short.
 */
function migrate(database: Database): void {
	const columns = database
		.query("PRAGMA table_info(connections)")
		.all() as { name: string }[];
	if (columns.some((column) => column.name === "hidden_databases")) return;
	database.run(
		"ALTER TABLE connections ADD COLUMN hidden_databases TEXT NOT NULL DEFAULT '[]'",
	);
}

/** Opens the database on first use, then holds it for the process lifetime. */
export function appDb(): Database {
	if (db) return db;
	const folder = join(Utils.paths.appData, APP_DIR);
	mkdirSync(folder, { recursive: true });
	db = new Database(join(folder, DB_FILE));
	db.run(SCHEMA);
	migrate(db);
	return db;
}