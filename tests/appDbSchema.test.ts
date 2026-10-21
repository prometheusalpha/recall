import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate, SCHEMA } from "../src/bun/appDbSchema";

/**
 * The shape real installs have: created before `hidden_databases` existed, so
 * the column was appended after `position` and the CHECK predates Redis.
 */
const LEGACY = `
CREATE TABLE connections (
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
, hidden_databases TEXT NOT NULL DEFAULT '[]')`;

const LEGACY_ROW = `INSERT INTO connections VALUES
	('pg1', 'Local PG', 'postgres', 'localhost', 5432, 'postgres', 'app', 'public', 1,
	 'sslmode=require', 10, 30, 'note', 1, 0, 2, '["tmp"]')`;

const REDIS_ROW = `INSERT INTO connections (id, name, db_type, host, port, username,
	database, default_schema, ssl, url_params, connect_timeout_secs, query_timeout_secs,
	note, save_password, show_system_schemas, hidden_databases, options, position)
	VALUES ('r1', 'Cache', 'redis', 'localhost', 6379, '', '', '', 0, '', 10, 0, '', 1, 0, '[]', '{"defaultDb":3}', 3)`;

function open(setup: string[]): Database {
	const database = new Database(":memory:");
	for (const statement of setup) database.run(statement);
	database.run(SCHEMA);
	migrate(database);
	return database;
}

describe("connections migration", () => {
	test("a legacy table keeps every row and value, and accepts redis", () => {
		const database = open([LEGACY, LEGACY_ROW]);
		const row = database.query("SELECT * FROM connections WHERE id = 'pg1'").get() as Record<string, unknown>;
		expect(row).toMatchObject({
			name: "Local PG",
			db_type: "postgres",
			url_params: "sslmode=require",
			query_timeout_secs: 30,
			position: 2,
			hidden_databases: '["tmp"]',
			options: "{}",
		});
		database.run(REDIS_ROW);
		expect(database.query("SELECT count(*) AS n FROM connections").get()).toEqual({ n: 2 });
	});

	test("running it again is a no-op", () => {
		const database = open([LEGACY, LEGACY_ROW]);
		migrate(database);
		expect(database.query("SELECT count(*) AS n FROM connections").get()).toEqual({ n: 1 });
		expect(
			database.query("SELECT name FROM sqlite_master WHERE name = 'connections_legacy'").get(),
		).toBeNull();
	});

	test("a fresh file gets the new table directly", () => {
		const database = open([]);
		database.run(REDIS_ROW);
		expect(() => database.run(REDIS_ROW.replace("'r1'", "'r2'").replace("'redis'", "'mongo'"))).toThrow();
	});

	test("a table older than hidden_databases still migrates", () => {
		const database = open([LEGACY.replace(", hidden_databases TEXT NOT NULL DEFAULT '[]')", ")")]);
		database.run(REDIS_ROW);
		expect(database.query("SELECT hidden_databases FROM connections").get()).toEqual({
			hidden_databases: "[]",
		});
	});
});
