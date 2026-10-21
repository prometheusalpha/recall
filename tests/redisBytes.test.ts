import { expect, test } from "bun:test";
import { fromRedisBytes, toRedisBytes } from "../src/bun/redis/bytes";

test("valid UTF-8 has no base64", () => {
	const b = toRedisBytes(Buffer.from("héllo 世界", "utf8"));
	expect(b).toEqual({ text: "héllo 世界" });
	expect(fromRedisBytes(b).toString("utf8")).toBe("héllo 世界");
});

test("invalid UTF-8 carries base64 and an escaped label", () => {
	const raw = Buffer.from([0x61, 0xff, 0x00, 0x5c]);
	const b = toRedisBytes(raw);
	expect(b.base64).toBe(raw.toString("base64"));
	expect(b.text).toBe("a\\xff\\x00\\\\");
	expect(fromRedisBytes(b).equals(raw)).toBe(true);
});

test("base64 wins over text", () => {
	expect(fromRedisBytes({ text: "label", base64: "/w==" }).equals(Buffer.from([0xff]))).toBe(true);
});

test("empty", () => {
	expect(toRedisBytes(Buffer.alloc(0))).toEqual({ text: "" });
});
