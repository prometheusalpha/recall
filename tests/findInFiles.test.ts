import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findInFiles, MAX_ROWS, splitMask } from "../src/bun/findInFiles";
import type { FindInFilesRequest } from "../src/shared/findInFiles";

// Staged by `hutch scripts/fetch-rg.ts`; without it there is nothing to spawn.
const RG = join(import.meta.dir, "..", "vendor", "rg", "rg");
const run = existsSync(RG) ? test : test.skip;

let root: string;

function request(query: string, extra: Partial<FindInFilesRequest> = {}): FindInFilesRequest {
	return {
		folders: [root],
		query,
		mask: "*.sql",
		caseSensitive: false,
		regex: false,
		wholeWord: false,
		...extra,
	};
}

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "recall-fif-")));
	await writeFile(join(root, "a.sql"), "SELECT id\nFROM users u JOIN users v\nWHERE name = 'ủsers users';\n");
	await writeFile(join(root, "b.txt"), "users in a text file\n");
	await writeFile(join(root, "users_only_in_name.sql"), "SELECT 1;\n");
	await mkdir(join(root, "node_modules"));
	await writeFile(join(root, "node_modules", "dep.sql"), "users\n");
	await mkdir(join(root, ".hidden"));
	await writeFile(join(root, ".hidden", "h.sql"), "select users;\n");
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("findInFiles", () => {
	run("one row per line, hits merged, columns in UTF-16 units", async () => {
		const result = await findInFiles(request("users"), RG);
		expect(result.error).toBeNull();
		const a = result.matches.filter((m) => m.path === join(root, "a.sql"));
		expect(a.map((m) => m.line)).toEqual([2, 3]);
		expect(a[0].ranges).toEqual([[5, 10], [18, 23]]);
		expect(a[0].column).toBe(5);
		// `ủ` is 3 bytes in UTF-8 but one UTF-16 unit; rg's byte offset would land on "sers".
		const line3 = a[1];
		for (const [start, end] of line3.ranges) {
			expect(line3.text.slice(start, end).toLowerCase()).toBe("users");
		}
	});

	run("never reports a file by name alone", async () => {
		const result = await findInFiles(request("users_only"), RG);
		expect(result.matches).toEqual([]);
	});

	run("mask filters, and `!` excludes", async () => {
		const all = await findInFiles(request("users", { mask: "*" }), RG);
		expect(all.matches.some((m) => m.path.endsWith("b.txt"))).toBe(true);
		const noSql = await findInFiles(request("users", { mask: "*,!*.sql" }), RG);
		expect(noSql.matches.every((m) => m.path.endsWith("b.txt"))).toBe(true);
	});

	run("skips IGNORE_DIRS but searches hidden folders, like the tree", async () => {
		const result = await findInFiles(request("users"), RG);
		expect(result.matches.some((m) => m.path.includes("node_modules"))).toBe(false);
		expect(result.matches.some((m) => m.path.includes(".hidden"))).toBe(true);
	});

	run("case sensitivity, whole word and regex flags", async () => {
		expect((await findInFiles(request("USERS", { caseSensitive: true }), RG)).matches).toEqual([]);
		const word = await findInFiles(request("user", { wholeWord: true }), RG);
		expect(word.matches).toEqual([]);
		const regex = await findInFiles(request("JOIN\\s+users", { regex: true }), RG);
		expect(regex.matches.map((m) => m.line)).toEqual([2]);
		// Fixed-string mode treats regex syntax literally.
		expect((await findInFiles(request("u.ers"), RG)).matches).toEqual([]);
	});

	run("a bad regex comes back as an error, not a throw", async () => {
		const result = await findInFiles(request("(", { regex: true }), RG);
		expect(result.matches).toEqual([]);
		expect(result.error).toContain("regex parse error");
	});

	run("caps rows and says so", async () => {
		const big = join(root, "big");
		await mkdir(big);
		await writeFile(join(big, "many.sql"), "needle\n".repeat(MAX_ROWS + 50));
		const result = await findInFiles(request("needle", { folders: [big] }), RG);
		expect(result.matches.length).toBe(MAX_ROWS);
		expect(result.truncated).toBe(true);
	});

	run("nested folders do not double rows; symlinked folder reports realpaths", async () => {
		const link = join(tmpdir(), `recall-fif-link-${process.pid}`);
		await rm(link, { force: true });
		await symlink(root, link);
		try {
			const result = await findInFiles(request("FROM users", { folders: [link, root] }), RG);
			expect(result.matches.length).toBe(1);
			expect(result.matches[0].path).toBe(join(root, "a.sql"));
		} finally {
			await rm(link, { force: true });
		}
	});

	run("a newer search supersedes the one still running", async () => {
		// The slow realpath of the first call must not let it win: a folder
		// list long enough that its awaits outlast the second call's.
		const many = { folders: Array.from({ length: 50 }, () => root) };
		const [first, second] = await Promise.all([
			findInFiles(request("users", many), RG),
			findInFiles(request("SELECT"), RG),
		]);
		expect(first.matches).toEqual([]);
		expect(second.matches.length).toBeGreaterThan(0);
	});

	run("calls in quick succession: only the last one answers", async () => {
		const [first, second] = await Promise.all([
			findInFiles(request("users"), RG),
			findInFiles(request("SELECT"), RG),
		]);
		expect(first.matches).toEqual([]);
		expect(second.matches.length).toBeGreaterThan(0);
	});

	test("splitMask keeps braces together", () => {
		expect(splitMask("*.{sql,md}, !test*.sql")).toEqual(["*.{sql,md}", "!test*.sql"]);
		expect(splitMask("*")).toEqual([]);
		expect(splitMask("")).toEqual([]);
	});
});
