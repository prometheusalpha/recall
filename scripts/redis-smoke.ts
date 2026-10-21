// Runtime smoke for the Redis backend; run through `hutch run redis:smoke` so it uses the app's Bun.
import { closeRedis, openRedis } from "../src/bun/redis/pool";
import { redisHandlers } from "../src/bun/redis/handlers";

const url = process.env.RECALL_TEST_REDIS_URL;
if (!url) throw new Error("set RECALL_TEST_REDIS_URL");
const u = new URL(url);
const id = "smoke";
const info = await openRedis({
	id,
	name: "smoke",
	host: u.hostname,
	port: Number(u.port || 6379),
	username: "",
	password: "",
	ssl: false,
	connectTimeoutSecs: 5,
	note: "",
	savePassword: false,
	dbType: "redis",
	defaultDb: 15,
});
console.log("open", JSON.stringify(info));
const scope = { connectionId: id, db: 15 };
const key = { text: "smoke:key" };
await redisHandlers.redisSetString({ ...scope, key, value: "hello", ttl: { mode: "seconds", seconds: 60 }, onlyIfAbsent: false });
console.log("get", JSON.stringify(await redisHandlers.redisGetValue({ ...scope, key })));
console.log("scan", JSON.stringify(await redisHandlers.redisScanKeys({ ...scope, cursor: "0", pattern: "smoke:*", count: 100 })));
console.log("exec", JSON.stringify(await redisHandlers.redisExecute({ ...scope, command: "GET smoke:key", confirmed: false })));
console.log("del", await redisHandlers.redisDeleteKeys({ ...scope, keys: [key] }));
await closeRedis(id);
console.log("closed");
process.exit(0);
