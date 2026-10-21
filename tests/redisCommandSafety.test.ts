import { describe, expect, test } from "bun:test";
import {
	classifyCommand,
	isConnectionHijacking,
	parseCommandLine,
} from "../src/bun/redis/commandSafety";

describe("classifyCommand", () => {
	test("allowlisted reads, case-insensitive", () => {
		for (const c of ["GET", "get", "HGETALL", "SCAN", "JSON.GET"]) {
			expect(classifyCommand(c)).toBe("read");
		}
	});

	test("everything else, including dangerous and unknown, is write", () => {
		for (const c of ["SET", "DEL", "KEYS", "MONITOR", "SUBSCRIBE", "PSUBSCRIBE", "FLUSHALL", "FLUSHDB", "DEBUG", "SHUTDOWN", "NEWCMD"]) {
			expect(classifyCommand(c)).toBe("write");
		}
	});

	test("connection hijacking commands", () => {
		for (const c of ["monitor", "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "SYNC", "PSYNC"]) {
			expect(isConnectionHijacking(c)).toBe(true);
		}
		expect(isConnectionHijacking("GET")).toBe(false);
	});
});

describe("parseCommandLine", () => {
	test("plain, quotes and escapes", () => {
		expect(parseCommandLine("GET  foo")).toEqual(["GET", "foo"]);
		expect(parseCommandLine('SET k "a b"')).toEqual(["SET", "k", "a b"]);
		expect(parseCommandLine("SET k 'a b'")).toEqual(["SET", "k", "a b"]);
		expect(parseCommandLine('SET k "a\\nb"')).toEqual(["SET", "k", "a\nb"]);
		expect(parseCommandLine('SET k ""')).toEqual(["SET", "k", ""]);
		expect(parseCommandLine("SET k a\\ b")).toEqual(["SET", "k", "a b"]);
	});

	test("trailing semicolon dropped", () => {
		expect(parseCommandLine("HGETALL aaa;")).toEqual(["HGETALL", "aaa"]);
	});

	test("errors", () => {
		expect(() => parseCommandLine('GET "oops')).toThrow(/unterminated/);
		expect(() => parseCommandLine("   ")).toThrow(/empty/);
	});
});
