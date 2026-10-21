/**
 * Redis domain types and the Redis half of the RPC contract. Type-only, like
 * the rest of `src/shared/`.
 */

/**
 * Bytes as they cross the RPC boundary. Redis keys, fields and values are
 * binary-safe, and a JS string is not: decoding invalid UTF-8 replaces bytes,
 * so writing it back would corrupt the key. `base64` is present exactly when
 * the bytes are not valid UTF-8; then `text` is an escaped label for display
 * and the bytes are read-only in the UI.
 */
export interface RedisBytes {
	text: string;
	base64?: string;
}

export interface RedisDatabase {
	db: number;
	/** From `INFO keyspace`; 0 for a database the server lists as empty. */
	keys: number;
}

export interface RedisKeyInfo {
	key: RedisBytes;
	/** `TYPE` as the server reports it: `string`, `hash`, `ReJSON-RL`, … */
	type: string;
	/** Seconds; -1 when the key never expires, -2 when it is already gone. */
	ttl: number;
}

export interface RedisScanPage {
	/** "0" when the scan is complete. */
	cursor: string;
	keys: RedisKeyInfo[];
	/** `DBSIZE`, sent on the first page only; null on later pages. */
	totalKeys: number | null;
}

export interface RedisHashEntry {
	field: RedisBytes;
	value: RedisBytes;
}

export interface RedisHashPage {
	entries: RedisHashEntry[];
	/** "0" when every field has been read. */
	cursor: string;
}

export type RedisValue =
	| {
			type: "string";
			ttl: number;
			value: RedisBytes;
			/** `STRLEN`: the full size, which may exceed what was read. */
			byteLength: number;
			/** True when only a prefix was read; the value is then read-only. */
			truncated: boolean;
	  }
	| {
			type: "hash";
			ttl: number;
			/** `HLEN`. */
			length: number;
			firstPage: RedisHashPage;
	  }
	/** A type this build cannot show yet; the console still reaches it. */
	| { type: "unsupported"; ttl: number; redisType: string };

/**
 * What a write does to the key's expiry. `keep` is the default for edits: a
 * cache entry that loses its TTL on save quietly becomes permanent.
 */
export type RedisTtlChange =
	| { mode: "keep" }
	| { mode: "persist" }
	| { mode: "seconds"; seconds: number };

/** `read` runs at once; `write` covers everything not known to be read-only. */
export type RedisCommandSafety = "read" | "write";

export type RedisCommandResult =
	| { status: "ok"; reply: RedisReply; timeMs: number }
	| { status: "error"; message: string; timeMs: number }
	/** Nothing was sent: the command is not read-only and was not confirmed. */
	| { status: "needsConfirmation"; command: string };

/** A RESP reply in JSON-safe form; bulk strings arrive as `RedisBytes`. */
export type RedisReply =
	| null
	| number
	| RedisBytes
	| { error: string }
	| RedisReply[];

/** Every Redis request names the profile and the logical database. */
interface DbScope {
	connectionId: string;
	db: number;
}

export type RedisRequests = {
	redisListDatabases: {
		params: { connectionId: string };
		response: RedisDatabase[];
	};
	/** One `SCAN` batch, each key with its `TYPE` and `TTL`. */
	redisScanKeys: {
		params: DbScope & { cursor: string; pattern: string; count: number };
		response: RedisScanPage;
	};
	/** Null when the key no longer exists. */
	redisGetValue: {
		params: DbScope & { key: RedisBytes };
		response: RedisValue | null;
	};
	redisHashScan: {
		params: DbScope & { key: RedisBytes; cursor: string };
		response: RedisHashPage;
	};
	/**
	 * Create or overwrite a string. `onlyIfAbsent` is for the "new key" form, so
	 * creating never silently replaces a key that already exists; it then
	 * resolves false instead of writing.
	 */
	redisSetString: {
		params: DbScope & {
			key: RedisBytes;
			value: string;
			ttl: RedisTtlChange;
			onlyIfAbsent: boolean;
		};
		response: boolean;
	};
	/**
	 * Set one hash field. `previousField` renames: the old field goes in the
	 * same transaction. `onlyIfAbsent` refuses when the key already exists.
	 */
	redisHashSet: {
		params: DbScope & {
			key: RedisBytes;
			field: RedisBytes;
			value: string;
			previousField?: RedisBytes;
			ttl: RedisTtlChange;
			onlyIfAbsent: boolean;
		};
		response: boolean;
	};
	redisHashDelete: {
		params: DbScope & { key: RedisBytes; field: RedisBytes };
		response: void;
	};
	/** Returns how many keys were removed. */
	redisDeleteKeys: {
		params: DbScope & { keys: RedisBytes[] };
		response: number;
	};
	/** Returns the TTL after the change, in seconds (-1 when persistent). */
	redisSetTtl: {
		params: DbScope & {
			key: RedisBytes;
			ttl: Exclude<RedisTtlChange, { mode: "keep" }>;
		};
		response: number;
	};
	/**
	 * One console line. The backend classifies it: a command outside the
	 * read-only allowlist comes back `needsConfirmation` unless `confirmed`.
	 */
	redisExecute: {
		params: DbScope & { command: string; confirmed: boolean };
		response: RedisCommandResult;
	};
};
