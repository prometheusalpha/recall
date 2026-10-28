import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { driverFor } from "../src/bun/driver";
import type { SqlConnectionConfig } from "../src/shared/types";

// The integration half needs the docker MySQL from compose.yaml:
//   docker compose up -d mysql
//   RECALL_TEST_MYSQL_URL=mysql://root:mysql@127.0.0.1:53306/recall_test bun run test
const MYSQL_URL = process.env.RECALL_TEST_MYSQL_URL;
const target = MYSQL_URL ? new URL(MYSQL_URL) : null;
const TEST_DB = target?.pathname.replace(/^\//, "") || "recall_test";
const mysql = driverFor("mysql");

function config(overrides: Partial<SqlConnectionConfig> = {}): SqlConnectionConfig {
	return {
		id: "mysql-public-key",
		name: "mysql public key",
		host: target?.hostname ?? "127.0.0.1",
		port: Number(target?.port || 3306),
		username: "sha2",
		password: "pw",
		ssl: false,
		connectTimeoutSecs: 5,
		note: "",
		savePassword: false,
		dbType: "mysql",
		database: "",
		defaultSchema: "",
		urlParams: "",
		queryTimeoutSecs: 0,
		showSystemSchemas: false,
		hiddenDatabases: [],
		...overrides,
	};
}

describe("mysql allowPublicKeyRetrieval option", () => {
	test("is on by default", () => {
		expect(mysql.buildOptions(config())).toMatchObject({ allowPublicKeyRetrieval: true });
	});

	test("URL params can turn it off, and it is not forwarded into the url", () => {
		const options = mysql.buildOptions(
			config({ urlParams: "allowPublicKeyRetrieval=false" }),
		) as SQL.PostgresOrMySQLOptions;
		expect(options.allowPublicKeyRetrieval).toBe(false);
		expect(options.url).toBeUndefined();
	});
});

describe.skipIf(target === null)("mysql caching_sha2 account without TLS", () => {
	let admin: SQL;

	// The compose root account is mysql_native_password, so a dedicated
	// caching_sha2 account is what reproduces a stock MySQL 8 login.
	beforeAll(async () => {
		admin = new SQL({
			adapter: "mysql",
			hostname: target?.hostname,
			port: Number(target?.port || 3306),
			username: decodeURIComponent(target?.username ?? "") || "root",
			password: decodeURIComponent(target?.password ?? ""),
		});
		await admin.unsafe("DROP USER IF EXISTS sha2@'%'");
		await admin.unsafe(
			"CREATE USER sha2@'%' IDENTIFIED WITH caching_sha2_password BY 'pw'",
		);
		// Bun 1.4 picks `mysql` when no database is given, so the account gets
		// one of its own; only the login itself is under test here.
		await admin.unsafe(`GRANT ALL ON \`${TEST_DB}\`.* TO sha2@'%'`);
		// Drop the server's auth cache so the login takes the full RSA path.
		await admin.unsafe("FLUSH PRIVILEGES");
	});

	afterAll(async () => {
		await admin.unsafe("DROP USER IF EXISTS sha2@'%'");
		await admin.close();
	});

	async function login(cfg: SqlConnectionConfig): Promise<string> {
		const db = new SQL(mysql.buildOptions({ ...cfg, database: TEST_DB }));
		try {
			const rows = (await db.unsafe("SELECT CURRENT_USER() AS u")) as Array<{ u: string }>;
			return rows[0]?.u ?? "";
		} finally {
			await db.close({ timeout: 1 });
		}
	}

	test("connects with the default options", async () => {
		expect(await login(config())).toBe("sha2@%");
	});

	test("opting out reproduces the refusal", async () => {
		await expect(
			login(config({ urlParams: "allowPublicKeyRetrieval=false" })),
		).rejects.toMatchObject({ code: "ERR_MYSQL_PUBLIC_KEY_RETRIEVAL_NOT_ALLOWED" });
	});
});
