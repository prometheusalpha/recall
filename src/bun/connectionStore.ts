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
import type { SQLQueryBindings } from "bun:sqlite";
import type {
	ConnectionConfig,
	ConnectionProfile,
	DatabaseType,
} from "../shared/types";
import { appDb } from "./appDb";

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
	hidden_databases: string;
	options: string;
}

/** Fields only a Redis profile has; stored as JSON in `options`. */
interface RedisOptions {
	defaultDb: number;
}


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
	show_system_schemas, hidden_databases, options, position
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * The hidden-database names out of one row. Stored as a JSON array in a TEXT
 * column, so a hand-edited or truncated file has to degrade to "nothing is
 * hidden" rather than take the whole profile list down with it. Names are
 * filtered to strings because the one thing those names are used for is a
 * comparison, and a `null` in the list would only ever fail to match.
 */
function readHiddenDatabases(raw: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((name): name is string => typeof name === "string");
}

/** Same leniency as the hidden list: a damaged `options` falls back to db 0. */
function readRedisOptions(raw: string): RedisOptions {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { defaultDb: 0 };
	}
	const defaultDb = (parsed as { defaultDb?: unknown } | null)?.defaultDb;
	return {
		defaultDb:
			typeof defaultDb === "number" && Number.isInteger(defaultDb) && defaultDb >= 0
				? defaultDb
				: 0,
	};
}

function toConfig(row: ProfileRow): ConnectionConfig {
	const base = {
		id: row.id,
		name: row.name,
		host: row.host,
		port: row.port,
		username: row.username,
		password: "",
		ssl: row.ssl !== 0,
		connectTimeoutSecs: row.connect_timeout_secs,
		note: row.note,
		savePassword: row.save_password !== 0,
	};
	if (row.db_type === "redis") {
		return { ...base, dbType: "redis", ...readRedisOptions(row.options) };
	}
	return {
		...base,
		dbType: row.db_type,
		database: row.database,
		defaultSchema: row.default_schema,
		urlParams: row.url_params,
		queryTimeoutSecs: row.query_timeout_secs,
		showSystemSchemas: row.show_system_schemas !== 0,
		hiddenDatabases: readHiddenDatabases(row.hidden_databases),
	};
}

/** The columns whose values depend on the engine family. */
interface FamilyColumns {
	database: string;
	defaultSchema: string;
	urlParams: string;
	queryTimeoutSecs: number;
	showSystemSchemas: boolean;
	hiddenDatabases: string[];
	options: string;
}

/**
 * A Redis row fills the SQL-only columns with neutral values: the columns are
 * NOT NULL, and nothing reads them back for Redis.
 */
function familyColumns(profile: ConnectionProfile): FamilyColumns {
	if (profile.dbType === "redis") {
		const options: RedisOptions = { defaultDb: profile.defaultDb };
		return {
			database: "",
			defaultSchema: "",
			urlParams: "",
			queryTimeoutSecs: 0,
			showSystemSchemas: false,
			hiddenDatabases: [],
			options: JSON.stringify(options),
		};
	}
	return { ...profile, options: "{}" };
}


/**
 * Every stored profile, in sidebar order. `password` is always empty: the
 * keychain is the only place a secret lives, and `connect` asks the backend to
 * fill one in when a profile asks for it.
 */
export function listConnections(): ConnectionConfig[] {
	const rows = appDb()
		.query("SELECT * FROM connections ORDER BY position")
		.all() as ProfileRow[];
	return rows.map(toConfig);
}

/**
 * Replaces the stored list with `profiles`. The whole list goes in one
 * transaction, so a write that fails part-way leaves the previous profiles
 * intact instead of a half-empty sidebar.
 */
export function saveConnections(profiles: ConnectionProfile[]): void {
	const database = appDb();
	const wipe = database.query("DELETE FROM connections");
	const insert = database.query(INSERT);
	database.transaction((rows: ConnectionProfile[]) => {
		wipe.run();
		for (const [position, profile] of rows.entries()) {
			const family = familyColumns(profile);
			const values: SQLQueryBindings[] = [
				profile.id,
				profile.name,
				profile.dbType,
				profile.host,
				profile.port,
				profile.username,
				family.database,
				family.defaultSchema,
				profile.ssl ? 1 : 0,
				family.urlParams,
				profile.connectTimeoutSecs,
				family.queryTimeoutSecs,
				profile.note,
				profile.savePassword ? 1 : 0,
				family.showSystemSchemas ? 1 : 0,
				JSON.stringify(family.hiddenDatabases),
				family.options,
				position,
			];
			insert.run(...values);
		}
	})(profiles);
}