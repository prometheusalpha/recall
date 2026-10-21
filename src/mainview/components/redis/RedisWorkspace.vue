<script setup lang="ts">
/**
 * One Redis tab: keys on the left, the selected key's value on the right, the
 * console underneath. A tab is one logical db, carried in `tab.database`. The
 * key list is rescanned when the tab is opened rather than restored: a
 * keyspace changes under a closed tab, and a stale list would offer keys that
 * no longer exist.
 */
import { Pane, Splitpanes } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { computed, ref, watch } from "vue";
import type { RedisBytes, RedisKeyInfo } from "../../../shared/redis";
import { useRedisKeys } from "../../composables/useRedisKeys";
import { toast } from "../../composables/useToast";
import { bytesId } from "../../lib/redisFormat";
import { errorMessage } from "../../lib/rpc";
import { isConnectionCancelled, useConnectionsStore } from "../../stores/connections";
import type { Tab } from "../../stores/tabs";
import RedisConsole from "./RedisConsole.vue";
import RedisKeyList from "./RedisKeyList.vue";
import RedisNewKeyDialog from "./RedisNewKeyDialog.vue";
import RedisValuePanel from "./RedisValuePanel.vue";

const props = defineProps<{ tab: Tab }>();

const connections = useConnectionsStore();
const connectionId = computed(() => props.tab.connectionId);
const db = computed(() => Number(props.tab.database) || 0);
const list = useRedisKeys(connectionId, db);

const selected = ref<RedisKeyInfo | null>(null);
const selectedId = computed(() => (selected.value ? bytesId(selected.value.key) : null));
const creating = ref(false);
/** Bumped to make the value pane re-read after a console write. */
const valueVersion = ref(0);

async function open(): Promise<void> {
	selected.value = null;
	try {
		await connections.ensureConnected(connectionId.value);
		await list.reset("");
	} catch (err) {
		if (!isConnectionCancelled(err)) toast(errorMessage(err));
	}
}

watch(() => props.tab.id, () => void open(), { immediate: true });

async function search(pattern: string): Promise<void> {
	try {
		await list.reset(pattern);
	} catch (err) {
		toast(errorMessage(err));
	}
}

async function loadMore(): Promise<void> {
	try {
		await list.loadMore();
	} catch (err) {
		toast(errorMessage(err));
	}
}

function onDeleted(key: RedisBytes): void {
	list.forget(new Set([bytesId(key)]));
	selected.value = null;
}

function onUpdated(info: RedisKeyInfo): void {
	list.upsert(info);
	if (selectedId.value === bytesId(info.key)) selected.value = info;
}

function onCreated(info: RedisKeyInfo): void {
	list.upsert(info);
	selected.value = info;
}
</script>

<template>
	<Splitpanes horizontal class="min-h-0 flex-1">
		<Pane :size="72" class="flex min-h-0">
			<Splitpanes class="min-h-0 flex-1">
				<Pane :size="38" :min-size="20" class="flex min-h-0 flex-col">
					<RedisKeyList
						:keys="list.keys.value"
						:loading="list.loading.value"
						:done="list.done.value"
						:total-keys="list.totalKeys.value"
						:pattern="list.pattern.value"
						:selected-id="selectedId"
						@search="search"
						@load-more="loadMore"
						@select="selected = $event"
						@create="creating = true"
					/>
				</Pane>
				<Pane :min-size="30" class="flex min-h-0 flex-col">
					<RedisValuePanel
						:key="`${selectedId ?? ''}#${valueVersion}`"
						:connection-id="connectionId"
						:db="db"
						:target="selected"
						@deleted="onDeleted"
						@updated="onUpdated"
					/>
				</Pane>
			</Splitpanes>
		</Pane>
		<Pane :size="28" :min-size="10" class="flex min-h-0 flex-col border-t border-border">
			<RedisConsole :connection-id="connectionId" :db="db" @wrote="valueVersion++" />
		</Pane>
	</Splitpanes>
	<RedisNewKeyDialog v-model:open="creating" :connection-id="connectionId" :db="db" @created="onCreated" />
</template>
