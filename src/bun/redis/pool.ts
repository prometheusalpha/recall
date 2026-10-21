import Redis from "ioredis";
import type {
	ConnectionTestResult,
	DatabaseConnectionInfo,
	RedisConnectionConfig,
} from "../../shared/types";

/** Profile configs, kept until the user disconnects so a request can reopen its client. */
const profiles = new Map<string, RedisConnectionConfig>();
/** One client per (connection, logical db); SELECT on a shared socket would race. */
const clients = new Map<string, Redis>();
const opening = new Map<string, Promise<Redis>>();
const listeners = new Set<(connectionId: string, reason: string) => void>();
/** Clients closed on purpose, so their "end" event is not reported as a loss. */
const closing = new WeakSet<Redis>();

const MAX_RETRIES = 3;

function clientKey(connectionId: string, db: number): string {
	return `${connectionId.length}:${connectionId}${db}`;
}

/** A dead server should surface as connection-lost, not retry forever. */
function createClient(config: RedisConnectionConfig, db: number): Redis {
	return new Redis({
		host: config.host,
		port: config.port,
		db,
		lazyConnect: true,
		connectTimeout: Math.max(1, config.connectTimeoutSecs) * 1000,
		maxRetriesPerRequest: 1,
		...(config.ssl ? { tls: {} } : {}),
		...(config.username ? { username: config.username } : {}),
		...(config.password ? { password: config.password } : {}),
		retryStrategy: (times) => (times > MAX_RETRIES ? null : Math.min(times * 200, 1000)),
	});
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

async function connectClient(config: RedisConnectionConfig, db: number): Promise<Redis> {
	const client = createClient(config, db);
	// ioredis emits "error" on every failed attempt; without a listener it prints noise.
	client.on("error", () => {});
	try {
		await client.connect();
		await client.ping();
		return client;
	} catch (e) {
		closing.add(client);
		client.disconnect();
		throw e;
	}
}

function watchPrimary(config: RedisConnectionConfig, client: Redis) {
	client.on("end", () => {
		if (closing.has(client)) return;
		for (const l of listeners) l(config.id, "Redis connection closed");
	});
}

export async function openRedis(config: RedisConnectionConfig): Promise<DatabaseConnectionInfo> {
	await closeRedis(config.id);
	let client: Redis;
	try {
		client = await connectClient(config, config.defaultDb);
	} catch (e) {
		throw new Error(`Redis connection failed: ${errorMessage(e)}`);
	}
	profiles.set(config.id, config);
	clients.set(clientKey(config.id, config.defaultDb), client);
	watchPrimary(config, client);
	return { productName: "Redis", productVersion: await serverVersion(client), currentDatabase: `db${config.defaultDb}` };
}

async function serverVersion(client: Redis): Promise<string> {
	try {
		const info = await client.info("server");
		return /^redis_version:(.+)$/m.exec(info)?.[1]?.trim() ?? "";
	} catch {
		return "";
	}
}

export async function testRedis(config: RedisConnectionConfig): Promise<ConnectionTestResult> {
	let client: Redis | null = null;
	try {
		client = await connectClient(config, config.defaultDb);
		const version = await serverVersion(client);
		return {
			ok: true,
			message: `Connected to Redis ${version}`.trim(),
			databaseInfo: { productName: "Redis", productVersion: version, currentDatabase: `db${config.defaultDb}` },
			databases: [],
			schemas: [],
		};
	} catch (e) {
		return { ok: false, message: errorMessage(e), databaseInfo: null, databases: [], schemas: [] };
	} finally {
		if (client) {
			closing.add(client);
			client.disconnect();
		}
	}
}

export function redisClient(connectionId: string, db: number): Promise<Redis> {
	const key = clientKey(connectionId, db);
	const live = clients.get(key);
	if (live && live.status !== "end") return Promise.resolve(live);
	const config = profiles.get(connectionId);
	if (!config) return Promise.reject(new Error("Redis connection is not open"));
	const pending = opening.get(key);
	if (pending) return pending;
	const p = connectClient(config, db)
		.then((client) => {
			// A disconnect while this was opening must not leave a client behind.
			if (profiles.get(connectionId) !== config) {
				closing.add(client);
				client.disconnect();
				throw new Error("Redis connection is not open");
			}
			clients.set(key, client);
			if (db === config.defaultDb) watchPrimary(config, client);
			return client;
		})
		.finally(() => opening.delete(key));
	opening.set(key, p);
	return p;
}

/** For server-wide requests: the profile's own db, whose client is already open. */
export function redisServerClient(connectionId: string): Promise<Redis> {
	return redisClient(connectionId, profiles.get(connectionId)?.defaultDb ?? 0);
}

export async function closeRedis(connectionId: string): Promise<void> {
	profiles.delete(connectionId);
	const prefix = `${connectionId.length}:${connectionId}`;
	for (const [key, client] of [...clients]) {
		if (!key.startsWith(prefix)) continue;
		clients.delete(key);
		closing.add(client);
		client.disconnect();
	}
}

export async function closeAllRedis(): Promise<void> {
	for (const id of [...profiles.keys()]) await closeRedis(id);
}

export function isRedisConnected(connectionId: string): boolean {
	return profiles.has(connectionId);
}

export function onRedisConnectionLost(
	listener: (connectionId: string, reason: string) => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
