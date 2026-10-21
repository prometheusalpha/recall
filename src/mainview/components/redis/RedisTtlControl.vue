<script setup lang="ts">
/**
 * A key's expiry: a live countdown, and the two ways to change it — a new
 * relative TTL, or no expiry at all. The countdown runs locally from the TTL
 * the last read returned; the server is only asked again on refresh, so an
 * open key does not poll.
 */
import { Clock, Infinity as InfinityIcon } from "lucide-vue-next";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { RedisTtlChange } from "../../../shared/redis";
import { formatTtl } from "../../lib/redisFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const props = defineProps<{
	/** Seconds as last read; -1 never expires. */
	ttl: number;
	/** When `ttl` was read; a prop so a re-read of the same value restarts it. */
	readAt: number;
	busy: boolean;
}>();

const emit = defineEmits<{
	(e: "change", ttl: Exclude<RedisTtlChange, { mode: "keep" }>): void;
	/** The countdown reached zero: the key is gone on the server. */
	(e: "expired"): void;
}>();

const now = ref(Date.now());
const timer = setInterval(() => {
	now.value = Date.now();
}, 1000);
onBeforeUnmount(() => clearInterval(timer));

watch(
	() => props.readAt,
	(value) => {
		now.value = value;
	},
);

const remaining = computed(() => {
	if (props.ttl < 0) return props.ttl;
	return Math.max(0, props.ttl - Math.floor((now.value - props.readAt) / 1000));
});

watch(remaining, (value, previous) => {
	if (value === 0 && previous !== 0 && props.ttl > 0) emit("expired");
});

const editing = ref(false);
const secondsText = ref("");

function openEditor(): void {
	secondsText.value = remaining.value > 0 ? String(remaining.value) : "";
	editing.value = true;
}

function apply(): void {
	const seconds = Number.parseInt(secondsText.value, 10);
	if (!Number.isInteger(seconds) || seconds <= 0) return;
	emit("change", { mode: "seconds", seconds });
	editing.value = false;
}
</script>

<template>
	<div class="flex items-center gap-1 text-xs">
		<template v-if="!editing">
			<Button
				variant="ghost"
				size="xs"
				class="tabular-nums"
				:disabled="busy"
				title="Change TTL"
				@click="openEditor"
			>
				<Clock aria-hidden="true" />
				{{ formatTtl(remaining) }}
			</Button>
		</template>
		<form v-else class="flex items-center gap-1" @submit.prevent="apply" @keydown.esc="editing = false">
			<Input
				v-model="secondsText"
				type="number"
				min="1"
				class="h-6 w-24 text-xs"
				placeholder="Seconds"
				aria-label="TTL in seconds"
				autofocus
			/>
			<Button type="submit" size="xs" :disabled="busy">Set</Button>
			<Button
				type="button"
				variant="outline"
				size="xs"
				:disabled="busy || ttl === -1"
				title="Remove the expiry (PERSIST)"
				@click="emit('change', { mode: 'persist' }); editing = false"
			>
				<InfinityIcon aria-hidden="true" />
				No expiry
			</Button>
			<Button type="button" variant="ghost" size="xs" @click="editing = false">Cancel</Button>
		</form>
	</div>
</template>
