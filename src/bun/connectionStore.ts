/**
 * Connection profiles in SQLite.
 *
 * One row per profile in `recall.db`, under the app's data folder. Passwords
 * are deliberately absent: `credentialStore.ts` keeps those in the OS keychain,
 * so this file holds nothing the user would not recognise in a backup.
 *
 * The renderer owns the list and rewrites it whole. There are never more than
 * a handful of profiles, so one replace inside a single transaction is both
 * cheaper and harder to get wrong than row-by-row writes.
 */
import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Utils from "electrobun/main/utils";
import type {
	ConnectionConfig,
	ConnectionProfile,
	DatabaseType,
} from "../shared/types";

/**
 * Folder name under the OS data dir. Electrobun exposes no path helper for
 * the bundle identifier, so this is `app.identifier` from
 * `electrobun.config.ts` — keep the two in step.
 */
const APP_DIR = "app.recall.desktop";
const DB_FILE = "recall.db";

/** One row as SQLite hands it back: booleans arrive as 0 / 1 integers. */
interface ProfileRow {
	id: string;
	name: string;
	db_type: DatabaseType;
	host: string;
	port: number;
	username: string;
	database: string;
	default_schema: string;
	ssl: number;
	url_params: string;
	connect_timeout_secs: number;
	query_timeout_secs: number;
	note: string;
	save_password: number;
	show_system_schemas: number;
}

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
	position INTEGER NOT NULL
)`;

/**
 * Explicit column list, so a stray `password` on an incoming profile is dropped
 * rather than written somewhere the keychain owns. Parameters are positional:
 * bun:sqlite silently binds `null` to a named parameter whose object key is
 * missing the `$` prefix, which is a trap worth not walking into.
 */
const INSERT = `
INSERT INTO connections (
	id, name, db_type, host, port, username, database, default_schema, ssl,
	url_params, connect_timeout_secs, query_timeout_secs, note, save_password,
	show_system_schemas, position
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

let db: Database | null = null;

/** Opened on first use, then held for the lifetime of the Bun process. */
function store(): Database {
	if (db) return db;
	const folder = join(Utils.paths.appData, APP_DIR);
	mkdirSync(folder, { recursive: true });
	db = new Database(join(folder, DB_FILE));
	db.run(SCHEMA);
	return db;
}

/**
 * Every stored profile, in sidebar order. `password` is always empty: the
 * keychain is the only place a secret lives, and `connect` asks the backend to
 * fill one in when a profile asks for it.
 */
export function listConnections(): ConnectionConfig[] {
	const rows = store()
		.query("SELECT * FROM connections ORDER BY position")
		.all() as ProfileRow[];
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		dbType: row.db_type,
		host: row.host,
		port: row.port,
		username: row.username,
		password: "",
		database: row.database,
		defaultSchema: row.default_schema,
		ssl: row.ssl !== 0,
		urlParams: row.url_params,
		connectTimeoutSecs: row.connect_timeout_secs,
		queryTimeoutSecs: row.query_timeout_secs,
		note: row.note,
		savePassword: row.save_password !== 0,
		showSystemSchemas: row.show_system_schemas !== 0,
	}));
}

/**
 * Replaces the stored list with `profiles`. The whole list goes in one
 * transaction, so a write that fails part-way leaves the previous profiles
 * intact instead of a half-empty sidebar.
 */
export function saveConnections(profiles: ConnectionProfile[]): void {
	const database = store();
	const wipe = database.query("DELETE FROM connections");
	const insert = database.query(INSERT);
	database.transaction((rows: ConnectionProfile[]) => {
		wipe.run();
		for (const [position, profile] of rows.entries()) {
			const values: SQLQueryBindings[] = [
				profile.id,
				profile.name,
				profile.dbType,
				profile.host,
				profile.port,
				profile.username,
				profile.database,
				profile.defaultSchema,
				profile.ssl ? 1 : 0,
				profile.urlParams,
				profile.connectTimeoutSecs,
				profile.queryTimeoutSecs,
				profile.note,
				profile.savePassword ? 1 : 0,
				profile.showSystemSchemas ? 1 : 0,
				position,
			];
			insert.run(...values);
		}
	})(profiles);
}