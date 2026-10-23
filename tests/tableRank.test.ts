import { describe, expect, test } from "bun:test";
import { tableDemotion } from "../src/mainview/lib/tableRank";

const at = (schema: string, table: string) => ({ schema, table });

describe("tableDemotion", () => {
	test("ordinary tables are not demoted", () => {
		expect(tableDemotion(at("public", "users"))).toBe(0);
	});

	test("underscore-prefixed tables sit below ordinary ones", () => {
		expect(tableDemotion(at("public", "_migrations"))).toBe(1);
	});

	test("system schemas sit below everything", () => {
		expect(tableDemotion(at("pg_catalog", "pg_class"))).toBe(2);
		expect(tableDemotion(at("information_schema", "tables"))).toBe(2);
		expect(tableDemotion(at("pg_toast", "_x"))).toBe(2);
	});

	test("MySQL system databases, which arrive as the schema", () => {
		expect(tableDemotion(at("mysql", "user"))).toBe(2);
		expect(tableDemotion(at("sys", "sys_config"))).toBe(2);
	});
});
