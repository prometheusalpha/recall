/**
 * The key list of one Redis tab: a `SCAN` walk that loads a page at a time.
 *
 * Never `KEYS *`: that blocks the server for the whole keyspace. A scan page
 * may come back short or even empty while the cursor is still live — Redis
 * counts slots visited, not keys matched — so a sparse pattern keeps asking
 * until it has a screenful or the cursor wraps to "0".
 */
import { computed, ref, type Ref } from "vue";
import type { RedisKeyInfo } from "../../shared/redis";
import { bytesId } from "../lib/redisFormat";
import { RPC_TIMEOUTS, rpc } from "../lib/rpc";

/** `COUNT` hint per round trip. */
const SCAN_COUNT = 500;
/** Rows a "load more" aims for before handing control back. */
const PAGE_TARGET = 200;
/** Round trips one "load more" may spend chasing a sparse pattern. */
const MAX_ROUND_TRIPS = 20;

export function useRedisKeys(connectionId: Ref<string>, db: Ref<number>) {
	const keys = ref<RedisKeyInfo[]>([]);
	const cursor = ref("0");
	const started = ref(false);
	const loading = ref(false);
	const totalKeys = ref<number | null>(null);
	const pattern = ref("");
	/** Bumped on every reset, so a page that lands after one is dropped. */
	let generation = 0;

	const done = computed(() => started.value && cursor.value === "0");

	async function loadMore(): Promise<void> {
		if (loading.value || done.value) return;
		const mine = generation;
		loading.value = true;
		try {
			let added = 0;
			for (let trip = 0; trip < MAX_ROUND_TRIPS && added < PAGE_TARGET; trip++) {
				const page = await rpc.request.redisScanKeys(
					{
						connectionId: connectionId.value,
						db: db.value,
						cursor: cursor.value,
						pattern: pattern.value,
						count: SCAN_COUNT,
					},
					{ maxRequestTime: RPC_TIMEOUTS.metadata },
				);
				if (mine !== generation) return;
				if (page.totalKeys !== null) totalKeys.value = page.totalKeys;
				// SCAN may return a key twice across pages; the list must not.
				const seen = new Set(keys.value.map((entry) => bytesId(entry.key)));
				const fresh = page.keys.filter((entry) => !seen.has(bytesId(entry.key)));
				keys.value = [...keys.value, ...fresh];
				added += fresh.length;
				cursor.value = page.cursor;
				started.value = true;
				if (page.cursor === "0") break;
			}
		} finally {
			if (mine === generation) loading.value = false;
		}
	}

	/** Start over, e.g. for a new pattern or after the keyspace changed. */
	async function reset(nextPattern = pattern.value): Promise<void> {
		generation += 1;
		pattern.value = nextPattern;
		keys.value = [];
		cursor.value = "0";
		started.value = false;
		loading.value = false;
		totalKeys.value = null;
		await loadMore();
	}

	/** Drop keys the user deleted, without rescanning. */
	function forget(ids: Set<string>): void {
		keys.value = keys.value.filter((entry) => !ids.has(bytesId(entry.key)));
		if (totalKeys.value !== null) {
			totalKeys.value = Math.max(0, totalKeys.value - ids.size);
		}
	}

	/** Reflect a write in the list: the new TTL, or a key just created. */
	function upsert(info: RedisKeyInfo): void {
		const id = bytesId(info.key);
		const index = keys.value.findIndex((entry) => bytesId(entry.key) === id);
		if (index === -1) {
			keys.value = [info, ...keys.value];
			if (totalKeys.value !== null) totalKeys.value += 1;
		} else {
			keys.value = keys.value.map((entry, at) => (at === index ? info : entry));
		}
	}

	return { keys, loading, done, totalKeys, pattern, loadMore, reset, forget, upsert };
}
