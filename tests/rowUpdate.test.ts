import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { applyRowUpdates, buildRowUpdate } from "../src/bun/rowUpdate";
import { editsByRow } from "../src/mainview/lib/pendingEdits";

describe("buildRowUpdate", () => {
	const row = {
		keyValues: [7, "eu"],
		changes: [
			{ column: "name", value: "a" },
			{ column: "age", value: 3 },
		],
	};

	test("postgres numbers SET placeholders before the key", () => {
		const { sql, params } = buildRowUpdate("postgres", "public", "users", ["id", "region"], row);
		expect(sql).toBe(
			`UPDATE "public"."users" SET "name" = $1, "age" = $2 WHERE "id" = $3 AND "region" = $4`,
		);
		expect(params).toEqual(["a", 3, 7, "eu"]);
	});

	test("mysql binds positionally in text order", () => {
		const { sql, params } = buildRowUpdate("mysql", "shop", "users", ["id", "region"], row);
		expect(sql).toBe(
			"UPDATE `shop`.`users` SET `name` = ?, `age` = ? WHERE `id` = ? AND `region` = ?",
		);
		expect(params).toEqual(["a", 3, 7, "eu"]);
	});

	test("quotes break-out characters in identifiers", () => {
		const { sql } = buildRowUpdate("postgres", "", 'a"b', ["id"], {
			keyValues: [1],
			changes: [{ column: 'c"d', value: 1 }],
		});
		expect(sql).toBe(`UPDATE "a""b" SET "c""d" = $1 WHERE "id" = $2`);
	});
});

describe("editsByRow", () => {
	test("groups per row, rows and columns ascending", () => {
		const grouped = editsByRow([
			{ row: 4, resultCol: 2, value: "x" },
			{ row: 1, resultCol: 3, value: "y" },
			{ row: 4, resultCol: 0, value: "z" },
		]);
		expect(grouped.map((g) => g.row)).toEqual([1, 4]);
		expect(grouped[1]?.edits.map((e) => e.resultCol)).toEqual([0, 2]);
	});
});

const url = process.env.RECALL_TEST_PG_URL;

describe("applyRowUpdates on postgres", () => {
	test.skipIf(!url)("commits every row", async () => {
		const db = new SQL(url as string, { max: 2 });
		try {
			await db.unsafe("DROP TABLE IF EXISTS recall_row_update");
			await db.unsafe("CREATE TABLE recall_row_update (id int PRIMARY KEY, name text, n int)");
			await db.unsafe("INSERT INTO recall_row_update VALUES (1, 'a', 1), (2, 'b', 2)");
			const count = await applyRowUpdates(db, "postgres", "public", "recall_row_update", ["id"], [
				{ keyValues: [1], changes: [{ column: "name", value: "A" }, { column: "n", value: 10 }] },
				{ keyValues: [2], changes: [{ column: "name", value: null }] },
			]);
			expect(count).toBe(2);
			const rows = await db.unsafe("SELECT id, name, n FROM recall_row_update ORDER BY id");
			expect([...rows]).toEqual([
				{ id: 1, name: "A", n: 10 },
				{ id: 2, name: null, n: 2 },
			]);
		} finally {
			await db.unsafe("DROP TABLE IF EXISTS recall_row_update");
			await db.close();
		}
	});

	test.skipIf(!url)("rolls back earlier rows when a later one fails", async () => {
		const db = new SQL(url as string, { max: 2 });
		try {
			await db.unsafe("DROP TABLE IF EXISTS recall_row_update");
			await db.unsafe("CREATE TABLE recall_row_update (id int PRIMARY KEY, name text, n int)");
			await db.unsafe("INSERT INTO recall_row_update VALUES (1, 'a', 1), (2, 'b', 2)");
			const commit = applyRowUpdates(db, "postgres", "public", "recall_row_update", ["id"], [
				{ keyValues: [1], changes: [{ column: "name", value: "A" }] },
				{ keyValues: [2], changes: [{ column: "n", value: "not a number" }] },
			]);
			await expect(commit).rejects.toThrow();
			const rows = await db.unsafe("SELECT name FROM recall_row_update WHERE id = 1");
			expect(rows[0]?.name).toBe("a");
		} finally {
			await db.unsafe("DROP TABLE IF EXISTS recall_row_update");
			await db.close();
		}
	});
});
