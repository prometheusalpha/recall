import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
	closeConnection,
	getQueryConnection,
	openConnection,
} from "../src/bun/connectionPool";
import type { SqlConnectionConfig } from "../src/shared/types";

// Needs the docker MySQL from compose.yaml:
//   docker compose up -d mysql
//   RECALL_TEST_MYSQL_URL=mysql://root:mysql@127.0.0.1:53306/recall_test bun run test
const MYSQL_URL = process.env.RECALL_TEST_MYSQL_URL;
const target = MYSQL_URL ? new URL(MYSQL_URL) : null;
const DEFAULT_DB = target?.pathname.replace(/^\//, "") || "recall_test";
const OTHER_DB = "recall_test_other";

function config(): SqlConnectionConfig {
	if (!target) throw new Error("RECALL_TEST_MYSQL_URL is not set");
	return {
		id: "mysql-query-database",
		name: "mysql query database",
		host: target.hostname,
		port: Number(target.port || 3306),
		username: decodeURIComponent(target.username) || "root",
		password: decodeURIComponent(target.password),
		ssl: false,
		connectTimeoutSecs: 5,
		note: "",
		savePassword: false,
		dbType: "mysql",
		database: DEFAULT_DB,
		defaultSchema: "",
		urlParams: "",
		queryTimeoutSecs: 0,
		showSystemSchemas: false,
		hiddenDatabases: [],
	};
}

describe.skipIf(target === null)("mysql query database", () => {
	const cfg = target ? config() : null;
	let admin: SQL;

	// The same table name in both databases, holding different values, is what
	// tells an unqualified query which database it actually ran in.
	beforeAll(async () => {
		admin = new SQL({ ...(cfg as SqlConnectionConfig), adapter: "mysql", database: DEFAULT_DB });
		for (const [db, marker] of [
			[DEFAULT_DB, "default"],
			[OTHER_DB, "other"],
		]) {
			await admin.unsafe(`CREATE DATABASE IF NOT EXISTS \`${db}\``);
			await admin.unsafe(`DROP TABLE IF EXISTS \`${db}\`.t`);
			await admin.unsafe(`CREATE TABLE \`${db}\`.t (v VARCHAR(16))`);
			await admin.unsafe(`INSERT INTO \`${db}\`.t VALUES ('${marker}')`);
		}
		await openConnection(cfg as SqlConnectionConfig, true);
	});

	afterAll(async () => {
		if (!cfg) return;
		await closeConnection(cfg.id);
		await admin.unsafe(`DROP DATABASE IF EXISTS \`${OTHER_DB}\``);
		await admin.unsafe(`DROP TABLE IF EXISTS \`${DEFAULT_DB}\`.t`);
		await admin.close();
	});

	async function markerIn(database: string): Promise<string> {
		const { db } = await getQueryConnection(cfg!.id, database);
		const rows = (await db.unsafe("SELECT v FROM t")) as Array<{ v: string }>;
		return rows[0]?.v ?? "";
	}

	test("an unqualified query runs in the tab's database, not the profile's", async () => {
		expect(await markerIn(OTHER_DB)).toBe("other");
	});

	test("every pooled socket of the session is in that database", async () => {
		// Bun spreads concurrent statements over its pool; a `USE` on one socket
		// would leave the rest in the profile's default.
		const markers = await Promise.all(
			Array.from({ length: 20 }, () => markerIn(OTHER_DB)),
		);
		expect(new Set(markers)).toEqual(new Set(["other"]));
	});

	test("the profile's own database and an empty pick stay on the default", async () => {
		expect(await markerIn(DEFAULT_DB)).toBe("default");
		expect(await markerIn("")).toBe("default");
	});
});
