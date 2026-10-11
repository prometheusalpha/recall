<script setup lang="ts">
/**
 * One row of the EXPLAIN plan tree, recursive through `node.children`. Rows stay
 * single-line and scannable; the full operator details are toggled open inline
 * rather than in a popover, so a deeply nested tree can be read top to bottom
 * without losing the row that owns them. `rowDiffers` marks a node whose
 * measured rows diverge from the estimate, the classic sign of a bad plan.
 */
import { computed, ref } from "vue";
import { ChevronDown, ChevronRight, Info } from "lucide-vue-next";
import { Button } from "../ui/button";
import type { ExplainPlanNode } from "../../../shared/types";

const props = defineProps<{
	node: ExplainPlanNode;
}>();

const collapsed = ref(false);
const detailsOpen = ref(false);
const hasChildren = computed(() => props.node.children.length > 0);

interface ExplainPlanDetailEntry {
	label?: string;
	value: string;
}

const detailEntries = computed<ExplainPlanDetailEntry[]>(() =>
	props.node.details
		.map((detail): ExplainPlanDetailEntry => {
			const separatorIndex = detail.indexOf(":");
			if (separatorIndex === -1) return { value: detail.trim() };

			const label = detail.slice(0, separatorIndex).trim();
			return {
				label: label || undefined,
				value: detail.slice(separatorIndex + 1).trim(),
			};
		})
		.filter((detail) => detail.label || detail.value),
);

const detailPreviewEntries = computed(() => detailEntries.value.filter((detail) => detail.label !== "Actual Rows").slice(0, 2));

function toggleCollapsed() {
	collapsed.value = !collapsed.value;
}

function toggleDetails() {
	detailsOpen.value = !detailsOpen.value;
}

const actualRows = computed(() => {
	for (const detail of props.node.details) {
		const match = detail.match(/Actual Rows:\s*(\S+)/);
		if (match) return match[1];
	}
	return undefined;
});

const hasActualStats = computed(() => !!actualRows.value);
const rowDiffers = computed(() => hasActualStats.value && actualRows.value !== props.node.rows);
</script>

<template>
	<div>
		<div class="flex min-w-0 items-center gap-1 rounded border bg-background px-2 py-1 text-xs">
			<Button v-if="hasChildren" variant="ghost" size="icon-xs" class="-ml-1 h-5 w-5 shrink-0 text-foreground/80" :aria-label="node.title" :aria-expanded="!collapsed" @click="toggleCollapsed">
				<ChevronRight v-if="collapsed" class="h-3 w-3" aria-hidden="true" />
				<ChevronDown v-else class="h-3 w-3" aria-hidden="true" />
			</Button>
			<span v-else class="h-5 w-5 shrink-0" aria-hidden="true" />

			<span class="shrink-0 rounded bg-muted px-1 py-0.5 font-medium">{{ node.nodeType }}</span>
			<span v-if="node.relation" class="shrink-0 truncate max-w-[120px] text-foreground">{{ node.relation }}</span>
			<span v-if="node.index" class="shrink-0 font-medium text-foreground/80">[{{ node.index }}]</span>
			<span v-if="node.cost" class="shrink-0 tabular-nums text-foreground/80">c:{{ node.cost }}</span>
			<span v-if="node.rows" class="shrink-0 tabular-nums text-foreground/80">e:{{ node.rows }}</span>
			<span v-if="hasActualStats" class="shrink-0 tabular-nums font-semibold text-foreground"
				>a:{{ actualRows }}<span v-if="rowDiffers">({{ Math.round((Number(actualRows) / Number(node.rows)) * 100) }}%)</span></span
			>

			<div v-if="detailPreviewEntries.length" class="ml-1 flex min-w-0 flex-1 items-center gap-2 text-foreground/80">
				<span v-for="(detail, index) in detailPreviewEntries" :key="index" class="min-w-0 flex-1 truncate">
					<span v-if="detail.label" class="font-medium text-foreground">{{ detail.label }}:</span>
					{{ detail.value }}
				</span>
			</div>

			<Button v-if="detailEntries.length" variant="outline" size="xs" class="ml-auto h-5 shrink-0 gap-1 px-1.5 text-[11px] font-normal text-foreground/80" :aria-expanded="detailsOpen" aria-label="Details" @click="toggleDetails">
				<Info class="h-3 w-3" aria-hidden="true" />
				Details
			</Button>
		</div>

		<div v-if="detailsOpen && detailEntries.length" class="ml-3 mt-px rounded border bg-background p-2">
			<div v-for="(detail, index) in detailEntries" :key="index" class="space-y-1 border-b py-1.5 first:pt-0 last:border-b-0 last:pb-0">
				<div v-if="detail.label" class="text-[11px] font-medium">{{ detail.label }}</div>
				<div class="select-text whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-muted-foreground">{{ detail.value }}</div>
			</div>
		</div>

		<!-- Children (collapsible) -->
		<div v-if="node.children.length && !collapsed" class="ml-3 mt-px space-y-px border-l pl-2">
			<ExplainPlanNodeTree v-for="child in node.children" :key="child.id" :node="child" />
		</div>
	</div>
</template>
