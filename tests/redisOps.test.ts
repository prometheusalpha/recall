import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import { fromRedisBytes, toRedisBytes } from "../src/bun/redis/bytes";
import * as ops from "../src/bun/redis/ops";

const url = process.env.RECALL_TEST_REDIS_URL;
const d = url ? describe : describe.skip;

d("redis ops", () => {
	let client: Redis;
	const k = (text: string) => ({ text });

	beforeAll(async () => {
		client = new Redis(`${url}/15`);
		await client.flushdb();
	});
	afterAll(async () => {
		await client.flushdb();
		client.disconnect();
	});

	test("scan returns type and ttl, total on first page only", async () => {
		await client.set("scan:a", "1", "EX", 100);
		await client.hset("scan:b", "f", "v");
		const page = await ops.scanKeys(client, "0", "scan:*", 100);
		const byKey = Object.fromEntries(page.keys.map((i) => [i.key.text, i]));
		expect(byKey["scan:a"]!.type).toBe("string");
		expect(byKey["scan:a"]!.ttl).toBeGreaterThan(0);
		expect(byKey["scan:b"]!.type).toBe("hash");
		expect(byKey["scan:b"]!.ttl).toBe(-1);
		expect(page.totalKeys).toBeGreaterThanOrEqual(2);
		if (page.cursor !== "0") {
			expect((await ops.scanKeys(client, page.cursor, "scan:*", 100)).totalKeys).toBeNull();
		}
	});

	test("binary key round-trip", async () => {
		const raw = Buffer.from([0x62, 0xff, 0xfe]);
		await client.set(raw, "bin");
		const page = await ops.scanKeys(client, "0", "", 1000);
		const found = page.keys.find((i) => i.key.base64);
		expect(found).toBeDefined();
		expect(fromRedisBytes(found!.key).equals(raw)).toBe(true);
		const v = await ops.getValue(client, found!.key);
		expect(v).toMatchObject({ type: "string", value: { text: "bin" } });
		expect(await ops.deleteKeys(client, [found!.key])).toBe(1);
		expect(await ops.getValue(client, toRedisBytes(raw))).toBeNull();
	});

	test("setString ttl modes", async () => {
		const key = k("ttl:s");
		await ops.setString(client, key, "a", { mode: "seconds", seconds: 100 }, false);
		expect(await client.ttl("ttl:s")).toBeGreaterThan(90);
		await ops.setString(client, key, "b", { mode: "keep" }, false);
		expect(await client.get("ttl:s")).toBe("b");
		expect(await client.ttl("ttl:s")).toBeGreaterThan(90);
		await ops.setString(client, key, "c", { mode: "persist" }, false);
		expect(await client.ttl("ttl:s")).toBe(-1);
		await ops.setString(client, key, "d", { mode: "keep" }, false);
		expect(await client.ttl("ttl:s")).toBe(-1);
	});

	test("setString onlyIfAbsent refuses existing", async () => {
		await client.set("nx:k", "orig");
		expect(await ops.setString(client, k("nx:k"), "new", { mode: "keep" }, true)).toBe(false);
		expect(await client.get("nx:k")).toBe("orig");
		expect(await ops.setString(client, k("nx:fresh"), "new", { mode: "keep" }, true)).toBe(true);
	});

	test("hashSet rename removes old field, onlyIfAbsent refuses", async () => {
		await client.hset("h:r", "old", "v1");
		expect(await ops.hashSet(client, k("h:r"), k("new"), "v2", k("old"), { mode: "keep" }, false)).toBe(true);
		expect(await client.hgetall("h:r")).toEqual({ new: "v2" });
		expect(await ops.hashSet(client, k("h:r"), k("x"), "y", undefined, { mode: "keep" }, true)).toBe(false);
		await ops.hashSet(client, k("h:r"), k("n2"), "y", undefined, { mode: "seconds", seconds: 50 }, false);
		expect(await client.ttl("h:r")).toBeGreaterThan(40);
		expect(await ops.setTtl(client, k("h:r"), { mode: "persist" })).toBe(-1);
	});

	test("hash value and delete", async () => {
		await client.hset("h:v", "a", "1", "b", "2");
		const v = await ops.getValue(client, k("h:v"));
		expect(v).toMatchObject({ type: "hash", length: 2 });
		await ops.hashDelete(client, k("h:v"), k("a"));
		expect(await client.hlen("h:v")).toBe(1);
	});

	test("truncated string", async () => {
		await client.set("big", "x".repeat(ops.STRING_READ_CAP + 10));
		const v = await ops.getValue(client, k("big"));
		expect(v).toMatchObject({ type: "string", truncated: true, byteLength: ops.STRING_READ_CAP + 10 });
		if (v?.type === "string") expect(v.value.text.length).toBe(ops.STRING_READ_CAP);
	});

	test("unsupported type", async () => {
		await client.rpush("lst", "a");
		expect(await ops.getValue(client, k("lst"))).toMatchObject({ type: "unsupported", redisType: "list" });
	});

	test("execute: confirmation, read, rejection, errors", async () => {
		expect(await ops.execute(client, "SET cx 1", false)).toEqual({ status: "needsConfirmation", command: "SET cx 1" });
		expect(await client.exists("cx")).toBe(0);
		expect((await ops.execute(client, "SET cx 1", true)).status).toBe("ok");
		const got = await ops.execute(client, "GET cx", false);
		expect(got).toMatchObject({ status: "ok", reply: { text: "1" } });
		const mon = await ops.execute(client, "MONITOR", true);
		expect(mon.status).toBe("error");
		const bad = await ops.execute(client, "INCR lst", true);
		expect(bad.status).toBe("error");
		expect((await ops.execute(client, "LRANGE lst 0 -1", false)).status).toBe("ok");
	});

	test("listDatabases", async () => {
		const dbs = await ops.listDatabases(client);
		expect(dbs.length).toBeGreaterThanOrEqual(16);
		expect(dbs[15]!.keys).toBeGreaterThan(0);
	});
});
