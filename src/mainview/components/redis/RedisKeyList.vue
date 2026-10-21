<script setup lang="ts">
/**
 * The left pane of a Redis tab: the pattern box, the scanned keys, and the
 * button that asks for the next batch. Owns no data — the keys come from
 * `useRedisKeys` in the workspace, so a write in the value pane can update the
 * row it came from.
 */
import { Loader2, Plus, RefreshCw, Search } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import type { RedisKeyInfo } from "../../../shared/redis";
import { bytesId, formatTtl } from "../../lib/redisFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** Must match the row's `h-7`. */
const ROW_HEIGHT = 28;

const props = defineProps<{
	keys: RedisKeyInfo[];
	loading: boolean;
	done: boolean;
	totalKeys: number | null;
	pattern: string;
	selectedId: string | null;
}>();

const emit = defineEmits<{
	(e: "search", pattern: string): void;
	(e: "loadMore"): void;
	(e: "select", key: RedisKeyInfo): void;
	(e: "create"): void;
}>();

const draft = ref(props.pattern);
watch(
	() => props.pattern,
	(value) => {
		draft.value = value;
	},
);

/**
 * A bare word means "keys containing it": typing `user` and getting only a
 * key literally named `user` is never what anyone wanted. A term that already
 * holds a glob character is taken as written.
 */
function submit(): void {
	const term = draft.value.trim();
	emit("search", term === "" || /[*?[]/.test(term) ? term : `*${term}*`);
}

/** Short type tags with a colour each, so a long list scans by type. */
const TYPE_TAGS: Record<string, { label: string; tone: string }> = {
	string: { label: "STR", tone: "text-sky-500" },
	hash: { label: "HASH", tone: "text-violet-500" },
	list: { label: "LIST", tone: "text-emerald-500" },
	set: { label: "SET", tone: "text-amber-500" },
	zset: { label: "ZSET", tone: "text-orange-500" },
	stream: { label: "STRM", tone: "text-pink-500" },
};

function typeTag(type: string): { label: string; tone: string } {
	return TYPE_TAGS[type] ?? { label: type.slice(0, 4).toUpperCase(), tone: "text-muted-foreground" };
}

const rows = computed(() =>
	props.keys.map((entry) => ({ ...entry, id: bytesId(entry.key) })),
);
</script>

<template>
	<div class="flex h-full min-h-0 flex-col">
		<form class="flex shrink-0 items-center gap-1 border-b border-border p-1" @submit.prevent="submit">
			<div class="relative min-w-0 flex-1">
				<Search class="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<Input
					v-model="draft"
					class="h-7 pl-7 font-mono text-xs"
					placeholder="Filter keys, e.g. user:*"
					spellcheck="false"
					autocomplete="off"
					autocorrect="off"
					autocapitalize="off"
					aria-label="Key pattern"
				/>
			</div>
			<Button type="submit" variant="ghost" size="icon-sm" aria-label="Rescan" title="Rescan">
				<RefreshCw aria-hidden="true" />
			</Button>
			<Button type="button" variant="ghost" size="icon-sm" aria-label="New key" title="New key" @click="emit('create')">
				<Plus aria-hidden="true" />
			</Button>
		</form>

		<RecycleScroller
			v-slot="{ item }"
			class="recall-scroll min-h-0 flex-1"
			:items="rows"
			:item-size="ROW_HEIGHT"
			key-field="id"
		>
			<button
				type="button"
				class="flex h-7 w-full items-center gap-2 px-2 text-left text-xs hover:bg-muted"
				:class="{ 'bg-accent text-accent-foreground': item.id === selectedId }"
				:title="item.key.text"
				@click="emit('select', item)"
			>
				<span class="w-9 shrink-0 font-mono text-[10px] font-semibold" :class="typeTag(item.type).tone">
					{{ typeTag(item.type).label }}
				</span>
				<span class="min-w-0 flex-1 truncate font-mono" :class="{ 'italic text-muted-foreground': item.key.base64 }">
					{{ item.key.text }}
				</span>
				<span v-if="item.ttl >= 0" class="shrink-0 tabular-nums text-muted-foreground">
					{{ formatTtl(item.ttl) }}
				</span>
			</button>
		</RecycleScroller>

		<div class="flex h-7 shrink-0 items-center gap-2 border-t border-border px-2 text-xs text-muted-foreground">
			<span class="tabular-nums">
				<!-- DBSIZE counts the whole db, not the pattern's matches. -->
				{{ keys.length }} loaded<template v-if="totalKeys !== null"> · {{ totalKeys }} in db</template>
			</span>
			<Loader2 v-if="loading" class="size-3 animate-spin" aria-hidden="true" />
			<Button
				v-else-if="!done"
				variant="ghost"
				size="micro"
				class="ml-auto"
				@click="emit('loadMore')"
			>
				Load more
			</Button>
			<span v-else-if="keys.length === 0" class="ml-auto">No keys match</span>
		</div>
	</div>
</template>
