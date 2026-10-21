import type { RedisCommandSafety } from "../../shared/redis";

/**
 * Read access is an explicit allowlist, so a command from a newer Redis, a
 * module or a proxy is treated as a write until someone reviews it. Anything
 * that blocks, streams or scans the whole keyspace (KEYS, MONITOR, SUBSCRIBE,
 * FLUSH*, DEBUG, SHUTDOWN) is deliberately absent, and so are reads that can
 * block (XREAD, WAIT, WAITAOF): the console shares its socket with the key
 * browser, so a blocked read freezes the whole tab.
 */
const READ_ONLY = new Set(
	`BITCOUNT BITFIELD_RO BITPOS COMMAND DBSIZE DUMP ECHO EXISTS EXPIRETIME GEODIST GEOHASH GEOPOS
GEORADIUS_RO GEORADIUSBYMEMBER_RO GEOSEARCH GET GETBIT GETRANGE HEXISTS HGET HGETALL HKEYS HLEN HMGET
HRANDFIELD HSCAN HSTRLEN HPTTL HTTL HVALS INFO LASTSAVE LCS LINDEX LLEN LPOS LRANGE MGET OBJECT
PEXPIRETIME PFCOUNT PING PTTL PUBSUB RANDOMKEY ROLE SCAN SCARD SDIFF SINTER SINTERCARD SISMEMBER
SMEMBERS SMISMEMBER SORT_RO SRANDMEMBER SSCAN STRLEN SUNION TIME TTL TYPE XINFO XLEN
XPENDING XRANGE XREVRANGE ZCARD ZCOUNT ZDIFF ZINTER ZINTERCARD ZLEXCOUNT ZMSCORE ZRANDMEMBER
ZRANGE ZRANGEBYLEX ZRANGEBYSCORE ZRANK ZREVRANGE ZREVRANGEBYLEX ZREVRANGEBYSCORE ZREVRANK ZSCAN ZSCORE
ZUNION BF.CARD BF.EXISTS BF.INFO BF.MEXISTS CF.COUNT CF.EXISTS CF.INFO CF.MEXISTS CMS.INFO CMS.QUERY
FT._LIST FT.AGGREGATE FT.DICTDUMP FT.EXPLAIN FT.EXPLAINCLI FT.INFO FT.PROFILE FT.SEARCH FT.SPELLCHECK
FT.SYNDUMP FT.TAGVALS GRAPH.RO_QUERY JSON.ARRINDEX JSON.ARRLEN JSON.GET JSON.MGET JSON.OBJKEYS
JSON.OBJLEN JSON.RESP JSON.STRLEN JSON.TYPE TDIGEST.BYRANK TDIGEST.BYREVRANK TDIGEST.CDF TDIGEST.INFO
TDIGEST.MAX TDIGEST.MIN TDIGEST.QUANTILE TDIGEST.RANK TDIGEST.REVRANK TDIGEST.TRIMMED_MEAN TOPK.INFO
TOPK.LIST TOPK.QUERY TS.GET TS.INFO TS.MGET TS.MRANGE TS.QUERYINDEX TS.RANGE`.split(/\s+/),
);

export function classifyCommand(name: string): RedisCommandSafety {
	return READ_ONLY.has(name.toUpperCase()) ? "read" : "write";
}

/** Commands that take over the socket; the console cannot serve them. */
const CONNECTION_HIJACKING = new Set([
	"MONITOR",
	"SUBSCRIBE",
	"PSUBSCRIBE",
	"SSUBSCRIBE",
	"SYNC",
	"PSYNC",
]);

export function isConnectionHijacking(name: string): boolean {
	return CONNECTION_HIJACKING.has(name.toUpperCase());
}

/**
 * Splits a console line like redis-cli: whitespace separates, quotes group,
 * backslash escapes (\n \r \t, anything else literal), a trailing `;` is
 * dropped. Throws on an unterminated quote or an empty line.
 */
export function parseCommandLine(text: string): string[] {
	const src = text.trimEnd().replace(/;+$/, "");
	const argv: string[] = [];
	let current = "";
	let quote: string | null = null;
	let escaping = false;
	let started = false;
	for (const ch of src) {
		if (escaping) {
			started = true;
			current += ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : ch;
			escaping = false;
		} else if (ch === "\\") {
			started = true;
			escaping = true;
		} else if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
		} else if (ch === '"' || ch === "'") {
			started = true;
			quote = ch;
		} else if (/\s/.test(ch)) {
			if (started) argv.push(current);
			current = "";
			started = false;
		} else {
			started = true;
			current += ch;
		}
	}
	if (escaping) current += "\\";
	if (quote) throw new Error("Redis command has an unterminated quote");
	if (started) argv.push(current);
	if (!argv[0]) throw new Error("Redis command is empty");
	return argv;
}
