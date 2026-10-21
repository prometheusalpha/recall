<script setup lang="ts">
/**
 * Creates a string or a hash. Creation refuses an existing key rather than
 * overwriting it: a typo'd name that matches a live key would otherwise
 * replace its value without a word.
 */
import { computed, ref, watch } from "vue";
import type { RedisKeyInfo, RedisTtlChange } from "../../../shared/redis";
import { errorMessage, RPC_TIMEOUTS, rpc } from "../../lib/rpc";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogScrollContent,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const props = defineProps<{
	open: boolean;
	connectionId: string;
	db: number;
}>();

const emit = defineEmits<{
	(e: "update:open", value: boolean): void;
	(e: "created", info: RedisKeyInfo): void;
}>();

const type = ref<"string" | "hash">("string");
const key = ref("");
const field = ref("");
const value = ref("");
const ttlText = ref("");
const failure = ref("");
const busy = ref(false);

watch(
	() => props.open,
	(open) => {
		if (!open) return;
		key.value = "";
		field.value = "";
		value.value = "";
		ttlText.value = "";
		failure.value = "";
	},
);

/** Empty means no expiry; anything else must be a positive whole number. */
const ttl = computed<RedisTtlChange | null>(() => {
	const text = ttlText.value.trim();
	if (text === "") return { mode: "persist" };
	const seconds = Number(text);
	return Number.isInteger(seconds) && seconds > 0 ? { mode: "seconds", seconds } : null;
});

const valid = computed(
	() => key.value !== "" && ttl.value !== null && (type.value === "string" || field.value !== ""),
);

async function create(): Promise<void> {
	if (!valid.value || busy.value || !ttl.value) return;
	busy.value = true;
	failure.value = "";
	const scope = { connectionId: props.connectionId, db: props.db };
	const options = { maxRequestTime: RPC_TIMEOUTS.metadata };
	try {
		const written =
			type.value === "string"
				? await rpc.request.redisSetString(
						{ ...scope, key: { text: key.value }, value: value.value, ttl: ttl.value, onlyIfAbsent: true },
						options,
					)
				: await rpc.request.redisHashSet(
						{
							...scope,
							key: { text: key.value },
							field: { text: field.value },
							value: value.value,
							ttl: ttl.value,
							onlyIfAbsent: true,
						},
						options,
					);
		if (!written) {
			failure.value = "A key with this name already exists.";
			return;
		}
		emit("created", {
			key: { text: key.value },
			type: type.value,
			ttl: ttl.value.mode === "seconds" ? ttl.value.seconds : -1,
		});
		emit("update:open", false);
	} catch (err) {
		failure.value = errorMessage(err);
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<Dialog :open="open" @update:open="emit('update:open', $event)">
		<DialogScrollContent class="sm:max-w-[480px]">
			<DialogHeader>
				<DialogTitle>New key</DialogTitle>
				<DialogDescription>Created in db{{ db }}. An existing key is never overwritten.</DialogDescription>
			</DialogHeader>

			<form class="grid gap-2.5" @submit.prevent="create">
				<div class="flex gap-1" role="radiogroup" aria-label="Type">
					<Button
						v-for="option in ['string', 'hash'] as const"
						:key="option"
						type="button"
						size="xs"
						:variant="type === option ? 'default' : 'outline'"
						role="radio"
						:aria-checked="type === option"
						@click="type = option"
					>
						{{ option === "string" ? "String" : "Hash" }}
					</Button>
				</div>
				<div>
					<Label for="redis-new-key" class="mb-1 block">Key</Label>
					<Input id="redis-new-key" v-model="key" class="font-mono" spellcheck="false" autocomplete="off" />
				</div>
				<div v-if="type === 'hash'">
					<Label for="redis-new-field" class="mb-1 block">First field</Label>
					<Input id="redis-new-field" v-model="field" class="font-mono" spellcheck="false" autocomplete="off" />
				</div>
				<div>
					<Label for="redis-new-value" class="mb-1 block">Value</Label>
					<textarea
						id="redis-new-value"
						v-model="value"
						rows="4"
						spellcheck="false"
						class="w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none focus-visible:border-ring"
					/>
				</div>
				<div>
					<Label for="redis-new-ttl" class="mb-1 block">TTL (seconds)</Label>
					<Input id="redis-new-ttl" v-model="ttlText" type="number" min="1" placeholder="Empty for no expiry" />
				</div>
				<p v-if="failure" class="text-xs text-destructive">{{ failure }}</p>
				<DialogFooter>
					<Button type="button" variant="ghost" @click="emit('update:open', false)">Cancel</Button>
					<Button type="submit" :disabled="!valid || busy">Create</Button>
				</DialogFooter>
			</form>
		</DialogScrollContent>
	</Dialog>
</template>
