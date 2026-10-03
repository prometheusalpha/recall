<script setup lang="ts">
/**
 * Statement switcher for a multi-statement batch.
 *
 * One pill per split statement, in execution order. Hidden entirely when the
 * batch produced a single statement — there is nothing to switch between.
 */
import { computed } from "vue";
import { useQueryStore } from "../../stores/query";

const props = defineProps<{
	/** Tab whose results are being switched between. */
	tabId: string;
}>();

const queryStore = useQueryStore();

const statements = computed(() => queryStore.results[props.tabId] ?? []);
const activeIndex = computed(
	() => queryStore.activeStatementIndex[props.tabId] ?? 0,
);

function select(index: number): void {
	queryStore.activeStatementIndex[props.tabId] = index;
}

/** Compact duration label; sub-100ms values keep one decimal. */
function formatMs(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
	return `${ms.toFixed(ms >= 10 ? 0 : 1)} ms`;
}
</script>

<template>
	<div
		v-if="statements.length > 1"
		class="flex h-7 shrink-0 items-center gap-1 border-b border-border bg-chrome px-1"
		role="tablist"
		aria-label="Statements in this batch"
	>
		<button
			v-for="(statement, index) in statements"
			:key="index"
			type="button"
			role="tab"
			class="tab-pill"
			:data-active="index === activeIndex"
			:aria-selected="index === activeIndex"
			:aria-label="`Show statement ${index + 1}`"
			@click="select(index)"
		>
			<span class="tabular-nums">#{{ index + 1 }}</span>
			<span
				v-if="statement.error"
				class="size-1.5 shrink-0 rounded-full bg-destructive"
				aria-hidden="true"
			/>
			<span class="text-[10px] tabular-nums text-muted-foreground">
				{{ formatMs(statement.executionTimeMs) }}
			</span>
		</button>
	</div>
</template>
