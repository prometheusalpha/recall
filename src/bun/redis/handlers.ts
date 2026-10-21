import type { RedisRequests } from "../../shared/redis";
import { redisClient, redisServerClient } from "./pool";
import * as ops from "./ops";

export const redisHandlers = {
	redisListDatabases: async ({ connectionId }) => {
		// CONFIG and INFO are server-wide, so any logical db answers.
		return ops.listDatabases(await redisServerClient(connectionId));
	},
	redisScanKeys: async ({ connectionId, db, cursor, pattern, count }) =>
		ops.scanKeys(await redisClient(connectionId, db), cursor, pattern, count),
	redisGetValue: async ({ connectionId, db, key }) =>
		ops.getValue(await redisClient(connectionId, db), key),
	redisHashScan: async ({ connectionId, db, key, cursor }) =>
		ops.hashScan(await redisClient(connectionId, db), key, cursor),
	redisSetString: async ({ connectionId, db, key, value, ttl, onlyIfAbsent }) =>
		ops.setString(await redisClient(connectionId, db), key, value, ttl, onlyIfAbsent),
	redisHashSet: async ({ connectionId, db, key, field, value, previousField, ttl, onlyIfAbsent }) =>
		ops.hashSet(
			await redisClient(connectionId, db),
			key,
			field,
			value,
			previousField,
			ttl,
			onlyIfAbsent,
		),
	redisHashDelete: async ({ connectionId, db, key, field }) =>
		ops.hashDelete(await redisClient(connectionId, db), key, field),
	redisDeleteKeys: async ({ connectionId, db, keys }) =>
		ops.deleteKeys(await redisClient(connectionId, db), keys),
	redisSetTtl: async ({ connectionId, db, key, ttl }) =>
		ops.setTtl(await redisClient(connectionId, db), key, ttl),
	redisExecute: async ({ connectionId, db, command, confirmed }) =>
		ops.execute(await redisClient(connectionId, db), command, confirmed),
} satisfies {
	[K in keyof RedisRequests]: (
		params: RedisRequests[K]["params"],
	) => RedisRequests[K]["response"] | Promise<RedisRequests[K]["response"]>;
};
