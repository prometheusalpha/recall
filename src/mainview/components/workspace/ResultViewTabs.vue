<script setup lang="ts">
/**
 * The result pane's view switch: the rows that were run, or the plan of the
 * statement that was explained.
 *
 * Rendered only once a tab has an explain to show, so a tab that never asked
 * for a plan keeps exactly the pane it had before — no empty switch, and no
 * second bar over the grid. The bar stays up after switching back to the rows,
 * which is what makes the plan reachable again without asking for it twice.
 */
import type { ResultView } from "../../stores/query";

defineProps<{
	view: ResultView;
}>();

const emit = defineEmits<{ "update:view": [view: ResultView] }>();

const VIEWS: Array<{ id: ResultView; label: string }> = [
	{ id: "result", label: "Result" },
	{ id: "explain", label: "Explain" },
];
</script>

<template>
	<div
		class="flex h-7 shrink-0 items-center gap-1 border-b border-border bg-chrome px-1"
		role="tablist"
		aria-label="Result view"
	>
		<button
			v-for="entry in VIEWS"
			:key="entry.id"
			type="button"
			role="tab"
			class="tab-pill"
			:data-active="view === entry.id"
			:aria-selected="view === entry.id"
			@click="emit('update:view', entry.id)"
		>
			{{ entry.label }}
		</button>
	</div>
</template>
