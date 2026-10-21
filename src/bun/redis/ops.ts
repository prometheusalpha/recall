import type { Redis } from "ioredis";
import type {
	RedisBytes,
	RedisCommandResult,
	RedisDatabase,
	RedisHashPage,
	RedisReply,
	RedisScanPage,
	RedisTtlChange,
	RedisValue,
} from "../../shared/redis";
import { fromRedisBytes, toRedisBytes } from "./bytes";
import { classifyCommand, isConnectionHijacking, parseCommandLine } from "./commandSafety";

/** Larger strings are read as a prefix and shown read-only. */
export const STRING_READ_CAP = 1024 * 1024;
const HASH_PAGE_COUNT = 200;

function asText(v: unknown): string {
	return Buffer.isBuffer(v) ? v.toString("utf8") : String(v);
}

export async function scanKeys(
	client: Redis,
	cursor: string,
	pattern: string,
	count: number,
): Promise<RedisScanPage> {
	const [next, keys] = (await client.scanBuffer(
		cursor,
		"MATCH",
		pattern || "*",
		"COUNT",
		count,
	)) as [Buffer, Buffer[]];
	const pipe = client.pipeline();
	for (const k of keys) {
		pipe.callBuffer("TYPE", k);
		pipe.callBuffer("TTL", k);
	}
	const results = keys.length ? ((await pipe.exec()) ?? []) : [];
	const infos = keys.map((k, i) => {
		const type = results[i * 2]?.[1];
		const ttl = results[i * 2 + 1]?.[1];
		return { key: toRedisBytes(k), type: type ? asText(type) : "none", ttl: Number(ttl ?? -2) };
	});
	const totalKeys = cursor === "0" ? await client.dbsize() : null;
	return { cursor: asText(next), keys: infos, totalKeys };
}

async function typeAndTtl(client: Redis, key: Buffer): Promise<[string, number]> {
	const res = await client.pipeline().callBuffer("TYPE", key).callBuffer("TTL", key).exec();
	return [asText(res?.[0]?.[1]), Number(res?.[1]?.[1])];
}

export async function getValue(client: Redis, keyBytes: RedisBytes): Promise<RedisValue | null> {
	const key = fromRedisBytes(keyBytes);
	const [type, ttl] = await typeAndTtl(client, key);
	if (type === "none") return null;
	if (type === "string") {
		const byteLength = Number(await client.callBuffer("STRLEN", key).then(asText));
		const raw = (await client.callBuffer("GETRANGE", key, 0, STRING_READ_CAP - 1)) as Buffer | null;
		return {
			type: "string",
			ttl,
			value: toRedisBytes(raw ?? Buffer.alloc(0)),
			byteLength,
			truncated: byteLength > STRING_READ_CAP,
		};
	}
	if (type === "hash") {
		const length = Number(await client.callBuffer("HLEN", key).then(asText));
		return { type: "hash", ttl, length, firstPage: await hashScan(client, keyBytes, "0") };
	}
	return { type: "unsupported", ttl, redisType: type };
}

export async function hashScan(
	client: Redis,
	keyBytes: RedisBytes,
	cursor: string,
): Promise<RedisHashPage> {
	const [next, flat] = (await client.callBuffer(
		"HSCAN",
		fromRedisBytes(keyBytes),
		cursor,
		"COUNT",
		HASH_PAGE_COUNT,
	)) as [Buffer, Buffer[]];
	const entries = [];
	for (let i = 0; i + 1 < flat.length; i += 2) {
		entries.push({ field: toRedisBytes(flat[i]!), value: toRedisBytes(flat[i + 1]!) });
	}
	return { entries, cursor: asText(next) };
}

/**
 * `keep` reads PTTL and re-applies it in the same MULTI instead of using
 * KEEPTTL, which only exists from Redis 6.0. A concurrent TTL change between
 * the read and the MULTI is the accepted race.
 */
export async function setString(
	client: Redis,
	keyBytes: RedisBytes,
	value: string,
	ttl: RedisTtlChange,
	onlyIfAbsent: boolean,
): Promise<boolean> {
	const key = fromRedisBytes(keyBytes);
	const val = Buffer.from(value, "utf8");
	const nx = onlyIfAbsent ? ["NX"] : [];
	if (ttl.mode === "seconds") {
		return (await client.callBuffer("SET", key, val, "EX", ttl.seconds, ...nx)) !== null;
	}
	if (ttl.mode === "persist" || onlyIfAbsent) {
		return (await client.callBuffer("SET", key, val, ...nx)) !== null;
	}
	const pttl = Number(asText(await client.callBuffer("PTTL", key)));
	const multi = client.multi().callBuffer("SET", key, val);
	if (pttl > 0) multi.callBuffer("PEXPIRE", key, pttl);
	await execOrThrow(multi);
	return true;
}

export async function hashSet(
	client: Redis,
	keyBytes: RedisBytes,
	field: RedisBytes,
	value: string,
	previousField: RedisBytes | undefined,
	ttl: RedisTtlChange,
	onlyIfAbsent: boolean,
): Promise<boolean> {
	const key = fromRedisBytes(keyBytes);
	if (onlyIfAbsent && Number(asText(await client.callBuffer("EXISTS", key))) > 0) return false;
	const f = fromRedisBytes(field);
	const multi = client.multi();
	if (previousField) {
		const prev = fromRedisBytes(previousField);
		if (!prev.equals(f)) multi.callBuffer("HDEL", key, prev);
	}
	multi.callBuffer("HSET", key, f, Buffer.from(value, "utf8"));
	if (ttl.mode === "persist") multi.callBuffer("PERSIST", key);
	else if (ttl.mode === "seconds") multi.callBuffer("EXPIRE", key, ttl.seconds);
	await execOrThrow(multi);
	return true;
}

/** `exec()` resolves per-command errors as data; surface the first one. */
async function execOrThrow(multi: ReturnType<Redis["multi"]>): Promise<void> {
	const res = await multi.exec();
	const failed = res?.find(([err]) => err);
	if (failed?.[0]) throw failed[0];
}

export async function hashDelete(client: Redis, key: RedisBytes, field: RedisBytes): Promise<void> {
	await client.callBuffer("HDEL", fromRedisBytes(key), fromRedisBytes(field));
}

/** UNLINK frees memory off the main thread, so deleting a huge key does not stall the server. */
export async function deleteKeys(client: Redis, keys: RedisBytes[]): Promise<number> {
	if (!keys.length) return 0;
	const bufs = keys.map(fromRedisBytes);
	let removed = 0;
	for (let i = 0; i < bufs.length; i += 500) {
		removed += Number(asText(await client.callBuffer("UNLINK", ...bufs.slice(i, i + 500))));
	}
	return removed;
}

export async function setTtl(
	client: Redis,
	keyBytes: RedisBytes,
	ttl: Exclude<RedisTtlChange, { mode: "keep" }>,
): Promise<number> {
	const key = fromRedisBytes(keyBytes);
	if (ttl.mode === "persist") await client.callBuffer("PERSIST", key);
	else await client.callBuffer("EXPIRE", key, ttl.seconds);
	return Number(asText(await client.callBuffer("TTL", key)));
}

function toReply(v: unknown): RedisReply {
	if (v === null || v === undefined) return null;
	if (Buffer.isBuffer(v)) return toRedisBytes(v);
	if (typeof v === "number") return v;
	if (typeof v === "bigint") return { text: v.toString() };
	if (typeof v === "string") return { text: v };
	if (typeof v === "boolean") return v ? 1 : 0;
	if (v instanceof Error) return { error: v.message };
	if (Array.isArray(v)) return v.map(toReply);
	return { text: String(v) };
}

export async function execute(
	client: Redis,
	line: string,
	confirmed: boolean,
): Promise<RedisCommandResult> {
	const started = performance.now();
	const elapsed = () => Math.round(performance.now() - started);
	let argv: string[];
	try {
		argv = parseCommandLine(line);
	} catch (e) {
		return { status: "error", message: (e as Error).message, timeMs: 0 };
	}
	const [name, ...args] = argv as [string, ...string[]];
	if (isConnectionHijacking(name)) {
		return {
			status: "error",
			message: `${name.toUpperCase()} is not supported in the console: it takes over the connection`,
			timeMs: 0,
		};
	}
	if (!confirmed && classifyCommand(name) === "write") {
		return { status: "needsConfirmation", command: line };
	}
	try {
		const reply = await client.callBuffer(name, ...args);
		return { status: "ok", reply: toReply(reply), timeMs: elapsed() };
	} catch (e) {
		return { status: "error", message: e instanceof Error ? e.message : String(e), timeMs: elapsed() };
	}
}

export async function listDatabases(client: Redis): Promise<RedisDatabase[]> {
	let count = 16;
	try {
		const res = (await client.config("GET", "databases")) as string[];
		const n = Number(res?.[1]);
		if (Number.isInteger(n) && n > 0) count = n;
	} catch {
		// CONFIG may be renamed or denied (managed Redis); 16 is the server default.
	}
	const keys = new Map<number, number>();
	try {
		const info = await client.info("keyspace");
		for (const m of info.matchAll(/^db(\d+):keys=(\d+)/gm)) keys.set(Number(m[1]), Number(m[2]));
	} catch {
		// Counts are a nicety; the list is still useful without them.
	}
	return Array.from({ length: count }, (_, db) => ({ db, keys: keys.get(db) ?? 0 }));
}
