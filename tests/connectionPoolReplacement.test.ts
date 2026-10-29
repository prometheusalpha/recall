import { afterAll, describe, expect, test } from "bun:test";
import net from "node:net";
import {
	closeConnection,
	getConnection,
	isConnected,
	onConnectionLost,
	openConnection,
} from "../src/bun/connectionPool";
import type { SqlConnectionConfig } from "../src/shared/types";

// Needs the docker Postgres from compose.yaml:
//   docker compose up -d postgres
//   RECALL_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:55432/recall_test bun run test
const PG_URL = process.env.RECALL_TEST_PG_URL;
const target = PG_URL ? new URL(PG_URL) : null;

interface ProxyPair {
	client: net.Socket;
	upstream: net.Socket;
}

interface ReapingProxy {
	port: number;
	pairs: ProxyPair[];
	blackholeAll(): void;
	stop(): void;
}

/**
 * A TCP proxy that can silently stop forwarding without closing either side —
 * the shape of a socket reaped by a NAT or a firewall. The pool's probe is the
 * only thing that can notice, and it notices by timing out.
 */
async function startProxy(
	upstreamPort: number,
	upstreamHost: string,
): Promise<ReapingProxy> {
	const blackholed = new Set<net.Socket>();
	const pairs: ProxyPair[] = [];
	const server = net.createServer((client) => {
		const upstream = net.connect(upstreamPort, upstreamHost);
		pairs.push({ client, upstream });
		const forward = (from: net.Socket, to: net.Socket): void => {
			from.on("data", (chunk) => {
				if (!blackholed.has(client)) to.write(chunk);
			});
			from.on("error", () => {});
		};
		forward(client, upstream);
		forward(upstream, client);
		client.on("close", () => upstream.destroy());
		upstream.on("close", () => client.destroy());
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address() as net.AddressInfo;
	return {
		port: address.port,
		pairs,
		blackholeAll(): void {
			for (const pair of pairs) blackholed.add(pair.client);
		},
		stop(): void {
			for (const pair of pairs) {
				pair.client.destroy();
				pair.upstream.destroy();
			}
			server.close();
		},
	};
}

let profileSeq = 0;

function config(port: number): SqlConnectionConfig {
	if (!target) throw new Error("RECALL_TEST_PG_URL is not set");
	profileSeq += 1;
	return {
		id: `pool-replacement-${profileSeq}`,
		name: "pool replacement",
		host: "127.0.0.1",
		port,
		username: decodeURIComponent(target.username) || "postgres",
		password: decodeURIComponent(target.password),
		ssl: false,
		connectTimeoutSecs: 5,
		note: "",
		savePassword: false,
		dbType: "postgres",
		database: target.pathname.replace(/^\//, "") || "postgres",
		defaultSchema: "public",
		urlParams: "",
		queryTimeoutSecs: 0,
		showSystemSchemas: false,
		hiddenDatabases: [],
	};
}

describe.skipIf(target === null)("connection pool replacement", () => {
	const proxies: ReapingProxy[] = [];

	afterAll(() => {
		for (const proxy of proxies) proxy.stop();
	});

	// Real clocks on purpose: the behaviour under test is a native probe
	// timing out on a socket that never answers, which fake timers cannot drive.
	test(
		"a session replaced after a dead probe raises no connection-lost",
		async () => {
			const proxy = await startProxy(
				Number(target?.port || 5432),
				target?.hostname || "127.0.0.1",
			);
			proxies.push(proxy);
			const cfg = config(proxy.port);
			const losses: string[] = [];
			const unsubscribe = onConnectionLost((id, reason) => {
				if (id === cfg.id) losses.push(reason);
			});
			try {
				const live = await openConnection(cfg, true);
				await live.db.unsafe("select 1");
				// Only a session idle past the pool's probe threshold is probed,
				// so the reap is simulated after a real wait.
				await Bun.sleep(5_100);
				const replaced = [...proxy.pairs];
				proxy.blackholeAll();

				const next = await getConnection(cfg.id, cfg.database);
				expect(next).not.toBe(live);
				await next.db.unsafe("select 1");

				// The dead socket only goes away now, after its replacement owns
				// the pool key — the window this regression is about.
				for (const pair of replaced) {
					pair.client.destroy();
					pair.upstream.destroy();
				}
				await Bun.sleep(1_000);

				expect(losses).toEqual([]);
				expect(isConnected(cfg.id)).toBe(true);
				await next.db.unsafe("select 1");
			} finally {
				unsubscribe();
				await closeConnection(cfg.id);
			}
		},
		30_000,
	);

	// Opening a table asks for rows and key columns at once. The second request
	// arrives while the first one's probe is still waiting on the dead socket.
	test(
		"a request arriving during a probe is not handed the dead session",
		async () => {
			const proxy = await startProxy(
				Number(target?.port || 5432),
				target?.hostname || "127.0.0.1",
			);
			proxies.push(proxy);
			const cfg = config(proxy.port);
			try {
				const live = await openConnection(cfg, true);
				await live.db.unsafe("select 1");
				await Bun.sleep(5_100);
				proxy.blackholeAll();

				const run = async (): Promise<unknown> => {
					const session = await getConnection(cfg.id, cfg.database);
					return session.db.unsafe("select 1 as ok");
				};
				const results = await Promise.allSettled([run(), run()]);
				const failures = results.flatMap((result) =>
					result.status === "rejected"
						? [String((result.reason as { code?: string })?.code ?? result.reason)]
						: [],
				);
				expect(failures).toEqual([]);
			} finally {
				await closeConnection(cfg.id);
			}
		},
		30_000,
	);
});
