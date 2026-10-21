import { describe, expect, test } from "bun:test";
import { bytesId, formatReply, formatTtl } from "@/lib/redisFormat";

describe("formatTtl", () => {
	test("special values", () => {
		expect(formatTtl(-1)).toBe("No expiry");
		expect(formatTtl(-2)).toBe("Expired");
		expect(formatTtl(0)).toBe("0s");
	});

	test("keeps the two largest units", () => {
		expect(formatTtl(59)).toBe("59s");
		expect(formatTtl(61)).toBe("1m 1s");
		expect(formatTtl(3_600)).toBe("1h");
		expect(formatTtl(3 * 86_400 + 4 * 3_600 + 5)).toBe("3d 4h");
	});
});

describe("formatReply", () => {
	test("scalars", () => {
		expect(formatReply(null)).toBe("(nil)");
		expect(formatReply(3)).toBe("(integer) 3");
		expect(formatReply({ text: "OK" })).toBe('"OK"');
		expect(formatReply({ error: "ERR nope" })).toBe("(error) ERR nope");
		expect(formatReply([])).toBe("(empty array)");
	});

	test("nested arrays indent like redis-cli", () => {
		expect(formatReply([{ text: "a" }, [{ text: "b" }, 2]])).toBe(
			['1) "a"', '2) 1) "b"', "   2) (integer) 2"].join("\n"),
		);
	});
});

describe("bytesId", () => {
	test("text and binary with the same label stay distinct", () => {
		expect(bytesId({ text: "\\xff" })).not.toBe(
			bytesId({ text: "\\xff", base64: "/w==" }),
		);
	});
});
