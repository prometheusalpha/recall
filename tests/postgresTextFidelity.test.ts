import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { wrapForResulting } from "../src/bun/driver";
import { postgresDriver } from "../src/bun/drivers/postgres";

const textFidelitySql = postgresDriver.textFidelitySql;
if (!textFidelitySql) throw new Error("postgres driver must implement textFidelitySql");

const TEMPORAL = "timestamp with time zone";
const WALL = "timestamp without time zone";

// The projection is the only place a cast is decided, so its shape is asserted
// directly: a column is either re-read through the exact expression or left as
// the plain qualified reference.
describe("textFidelitySql", () => {
	test("returns null when no column needs a cast", () => {
		expect(textFidelitySql("SELECT id FROM t", ["id"], ["integer"])).toBeNull();
	});

	test("returns null for an empty column list", () => {
		expect(textFidelitySql("SELECT id FROM t", [], [])).toBeNull();
	});

	test("returns null for duplicate output names", () => {
		const sql = "SELECT a.id, b.id FROM a JOIN b ON true";
		expect(textFidelitySql(sql, ["id", "id"], ["integer", "integer"])).toBeNull();
	});

	test("casts timestamptz through to_jsonb(...) #>> '{}'", () => {
		const sql = textFidelitySql("SELECT ts FROM t", ["ts"], [TEMPORAL]);
		expect(sql).not.toBeNull();
		expect(sql).toContain(`to_jsonb(recall_cast."ts") #>> '{}' AS "ts"`);
	});

	test("casts timestamp without time zone through ::text", () => {
		const sql = textFidelitySql("SELECT wall FROM t", ["wall"], [WALL]);
		expect(sql).not.toBeNull();
		expect(sql).toContain(`recall_cast."wall"::text AS "wall"`);
	});

	test("leaves date, time, arrays and domains untouched", () => {
		const sql = textFidelitySql(
			"SELECT d, tm, arr, dom FROM t",
			["d", "tm", "arr", "dom"],
			["date", "time without time zone", `${TEMPORAL}[]`, "my_domain"],
		);
		expect(sql).toBeNull();
	});

	test("casts only the temporal column and keeps the rest plain", () => {
		const sql = textFidelitySql(
			"SELECT id, ts, name FROM t",
			["id", "ts", "name"],
			["integer", TEMPORAL, "text"],
		);
		expect(sql).toContain(`recall_cast."id" AS "id"`);
		expect(sql).toContain(`to_jsonb(recall_cast."ts") #>> '{}' AS "ts"`);
		expect(sql).toContain(`recall_cast."name" AS "name"`);
	});
});

describe("wrapForResulting", () => {
	test("embeds the body verbatim", () => {
		const body = "SELECT a + 1 AS one, b FROM t WHERE b > 2";
		const sql = wrapForResulting(body, ["one"], () => null);
		expect(sql).toContain(`FROM (${body}) AS recall_cast`);
	});

	test("drops one trailing semicolon from the body", () => {
		const sql = wrapForResulting("SELECT 1 AS n;", ["n"], () => null);
		expect(sql).toContain("FROM (SELECT 1 AS n) AS recall_cast");
		expect(sql).not.toContain(";)");
	});

	test("keeps column order and quotes each alias", () => {
		const sql = wrapForResulting("SELECT 1", ["b", "a"], () => null);
		expect(sql.indexOf(`AS "b"`)).toBeLessThan(sql.indexOf(`AS "a"`));
	});

	test("doubles an embedded quote in the reference and alias", () => {
		const sql = wrapForResulting("SELECT 1", ['we"ird'], () => null);
		expect(sql).toContain(`recall_cast."we""ird" AS "we""ird"`);
	});

	test("passes the declared type to the projection", () => {
		const seen: Array<[string, string]> = [];
		wrapForResulting(
			"SELECT ts, id FROM t",
			["ts", "id"],
			(column, type) => {
				seen.push([column, type]);
				return null;
			},
			[TEMPORAL, "integer"],
		);
		expect(seen).toEqual([
			[`recall_cast."ts"`, TEMPORAL],
			[`recall_cast."id"`, "integer"],
		]);
	});

	test("uses the plain reference when the projection returns null", () => {
		const sql = wrapForResulting("SELECT 1", ["id"], () => null);
		expect(sql).toBe(`SELECT recall_cast."id" AS "id" FROM (SELECT 1) AS recall_cast`);
	});
});

const url = process.env.RECALL_TEST_PG_URL;

// One pooled connection so the temp table survives across the statements; the
// real app database is never touched.
test.skipIf(!url)("reads microseconds back through the projection", async () => {
	const db = new SQL(url as string, { max: 1 });
	try {
		await db.unsafe("SET timezone = '+05:45'");
		await db.unsafe(
			"CREATE TEMP TABLE recall_fidelity (" +
				"ts timestamptz, wall timestamp, big bigint, bin bytea)",
		);
		await db.unsafe(
			"INSERT INTO recall_fidelity VALUES (" +
				"'2026-01-01 12:00:00.123456+00', " +
				"'2026-01-01 12:00:00.123456', " +
				"9007199254740993, " +
				"decode('00ff','hex'))",
		);

		const statement = "SELECT ts, wall, big, bin FROM recall_fidelity";
		const columns = ["ts", "wall", "big", "bin"];
		const types = await postgresDriver.columnTypes(db, statement, columns);
		expect(types).toContain(TEMPORAL);
		expect(types).toContain(WALL);

		const projected = textFidelitySql(statement, columns, types);
		expect(projected).not.toBeNull();

		const rows = (await db.unsafe(projected as string)) as Array<
			Record<string, unknown>
		>;
		const raw = (await db.unsafe(statement)) as Array<Record<string, unknown>>;
		const cell = rows[0];
		const plain = raw[0];

		// timestamptz arrives as ISO text with microseconds and a numeric offset
		// whose minutes are non-zero, so `Date.parse` still reads it.
		expect(typeof cell.ts).toBe("string");
		expect(cell.ts as string).toContain(".123456");
		expect(cell.ts as string).toMatch(/[+-]\d{2}:\d{2}$/);
		expect((cell.ts as string).slice(-2)).not.toBe("00");
		expect(Number.isFinite(Date.parse(cell.ts as string))).toBe(true);

		// timestamp keeps its microseconds too, without a zone.
		expect(typeof cell.wall).toBe("string");
		expect(cell.wall as string).toContain(".123456");

		// The other columns are exactly what an unprojected run returns.
		expect(cell.big).toBe(plain.big);
		expect(BigInt(cell.big as string)).toBe(9007199254740993n);
		expect(Array.from(cell.bin as Uint8Array)).toEqual(
			Array.from(plain.bin as Uint8Array),
		);
	} finally {
		await db.close();
	}
});
