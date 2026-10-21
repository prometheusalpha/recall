<script setup lang="ts">
/**
 * The right pane of a Redis tab: one key's value, its expiry, and the writes
 * on it. Every write keeps the key's TTL unless the TTL control is what
 * changed — a cache entry that turns permanent on save is the classic way a
 * Redis GUI fills a server up.
 */
import { Check, Copy, RefreshCw, Trash2 } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import type {
	RedisBytes,
	RedisHashEntry,
	RedisKeyInfo,
	RedisTtlChange,
	RedisValue,
} from "../../../shared/redis";
import { toast } from "../../composables/useToast";
import { bytesId } from "../../lib/redisFormat";
import { errorMessage, RPC_TIMEOUTS, rpc } from "../../lib/rpc";
import { Button } from "../ui/button";
import RedisHashView from "./RedisHashView.vue";
import RedisStringView from "./RedisStringView.vue";
import RedisTtlControl from "./RedisTtlControl.vue";

const props = defineProps<{
	connectionId: string;
	db: number;
	target: RedisKeyInfo | null;
}>();

const emit = defineEmits<{
	(e: "deleted", key: RedisBytes): void;
	(e: "updated", info: RedisKeyInfo): void;
}>();

const OPTIONS = { maxRequestTime: RPC_TIMEOUTS.metadata };

const value = ref<RedisValue | null>(null);
const readAt = ref(Date.now());
const hashEntries = ref<RedisHashEntry[]>([]);
const hashCursor = ref("0");
const loading = ref(false);
const busy = ref(false);
const missing = ref(false);
const confirmingDelete = ref(false);
const copied = ref(false);
/** Bumped per load, so a slow answer for the previous key is dropped. */
let generation = 0;

const scope = computed(() => ({ connectionId: props.connectionId, db: props.db }));

async function load(): Promise<void> {
	const key = props.target?.key;
	const mine = ++generation;
	confirmingDelete.value = false;
	if (!key) {
		value.value = null;
		return;
	}
	loading.value = true;
	try {
		const next = await rpc.request.redisGetValue({ ...scope.value, key }, OPTIONS);
		if (mine !== generation) return;
		missing.value = next === null;
		value.value = next;
		readAt.value = Date.now();
		if (next?.type === "hash") {
			hashEntries.value = next.firstPage.entries;
			hashCursor.value = next.firstPage.cursor;
		}
		if (next && props.target && next.ttl !== props.target.ttl) {
			emit("updated", { ...props.target, ttl: next.ttl });
		}
	} catch (err) {
		if (mine === generation) toast(errorMessage(err));
	} finally {
		if (mine === generation) loading.value = false;
	}
}

watch(() => (props.target ? bytesId(props.target.key) : null), () => void load(), {
	immediate: true,
});

/** Runs one write, then re-reads the key so the pane shows what Redis holds. */
async function write(action: () => Promise<unknown>): Promise<void> {
	if (busy.value) return;
	busy.value = true;
	try {
		await action();
		await load();
	} catch (err) {
		toast(errorMessage(err));
	} finally {
		busy.value = false;
	}
}

const KEEP: RedisTtlChange = { mode: "keep" };

function saveString(text: string): void {
	const key = props.target?.key;
	if (!key) return;
	void write(() =>
		rpc.request.redisSetString(
			{ ...scope.value, key, value: text, ttl: KEEP, onlyIfAbsent: false },
			OPTIONS,
		),
	);
}

function saveField(change: { field: RedisBytes; value: string; previousField?: RedisBytes }): void {
	const key = props.target?.key;
	if (!key) return;
	void write(() =>
		rpc.request.redisHashSet(
			{ ...scope.value, key, ...change, ttl: KEEP, onlyIfAbsent: false },
			OPTIONS,
		),
	);
}

function removeField(field: RedisBytes): void {
	const key = props.target?.key;
	if (!key) return;
	void write(() => rpc.request.redisHashDelete({ ...scope.value, key, field }, OPTIONS));
}

async function loadMoreFields(): Promise<void> {
	const key = props.target?.key;
	if (!key || hashCursor.value === "0") return;
	try {
		const page = await rpc.request.redisHashScan(
			{ ...scope.value, key, cursor: hashCursor.value },
			OPTIONS,
		);
		const seen = new Set(hashEntries.value.map((entry) => bytesId(entry.field)));
		hashEntries.value = [
			...hashEntries.value,
			...page.entries.filter((entry) => !seen.has(bytesId(entry.field))),
		];
		hashCursor.value = page.cursor;
	} catch (err) {
		toast(errorMessage(err));
	}
}

function changeTtl(ttl: Exclude<RedisTtlChange, { mode: "keep" }>): void {
	const key = props.target?.key;
	if (!key) return;
	void write(() => rpc.request.redisSetTtl({ ...scope.value, key, ttl }, OPTIONS));
}

async function deleteKey(): Promise<void> {
	const key = props.target?.key;
	if (!key || busy.value) return;
	busy.value = true;
	try {
		await rpc.request.redisDeleteKeys({ ...scope.value, keys: [key] }, OPTIONS);
		emit("deleted", key);
	} catch (err) {
		toast(errorMessage(err));
	} finally {
		busy.value = false;
		confirmingDelete.value = false;
	}
}

async function copyKey(): Promise<void> {
	if (!props.target) return;
	try {
		await navigator.clipboard.writeText(props.target.key.text);
		copied.value = true;
		setTimeout(() => (copied.value = false), 1500);
	} catch {
		toast("Could not copy the key");
	}
}
</script>

<template>
	<div v-if="!target" class="flex h-full items-center justify-center text-sm text-muted-foreground">
		Select a key
	</div>
	<div v-else class="flex h-full min-h-0 flex-col">
		<header class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
			<span class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-muted-foreground">
				{{ value?.type === "unsupported" ? value.redisType : (value?.type ?? target.type) }}
			</span>
			<span class="min-w-0 truncate font-mono text-xs" :title="target.key.text">{{ target.key.text }}</span>
			<Button variant="ghost" size="icon-xs" :aria-label="copied ? 'Copied' : 'Copy key'" @click="copyKey">
				<Check v-if="copied" aria-hidden="true" />
				<Copy v-else aria-hidden="true" />
			</Button>
			<span class="flex-1" />
			<RedisTtlControl
				v-if="value"
				:ttl="value.ttl"
				:read-at="readAt"
				:busy="busy"
				@change="changeTtl"
				@expired="load"
			/>
			<Button variant="ghost" size="icon-xs" aria-label="Reload value" title="Reload" :disabled="loading" @click="load">
				<RefreshCw :class="{ 'animate-spin': loading }" aria-hidden="true" />
			</Button>
			<template v-if="confirmingDelete">
				<Button variant="destructive" size="xs" :disabled="busy" @click="deleteKey">Delete key</Button>
				<Button variant="ghost" size="xs" @click="confirmingDelete = false">Cancel</Button>
			</template>
			<Button
				v-else
				variant="ghost"
				size="icon-xs"
				aria-label="Delete key"
				title="Delete key"
				@click="confirmingDelete = true"
			>
				<Trash2 aria-hidden="true" />
			</Button>
		</header>

		<div v-if="missing" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
			This key no longer exists. It may have expired or been deleted elsewhere.
		</div>
		<RedisStringView
			v-else-if="value?.type === 'string'"
			class="min-h-0 flex-1"
			:value="value.value"
			:byte-length="value.byteLength"
			:truncated="value.truncated"
			:busy="busy"
			@save="saveString"
		/>
		<RedisHashView
			v-else-if="value?.type === 'hash'"
			class="min-h-0 flex-1"
			:entries="hashEntries"
			:length="value.length"
			:has-more="hashCursor !== '0'"
			:busy="busy"
			@load-more="loadMoreFields"
			@save="saveField"
			@remove="removeField"
		/>
		<div v-else-if="value?.type === 'unsupported'" class="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
			{{ value.redisType }} values are not shown here yet. The console below can read and change them.
		</div>
	</div>
</template>
