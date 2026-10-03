<script setup lang="ts">
import { ChevronRight, Loader } from "lucide-vue-next";
import type { Component } from "vue";

/**
 * One row of the connection tree. Presentational only: the parent owns
 * expansion, selection and loading, and this row just reports clicks.
 *
 * Height comes from the prewritten `.tree-row` (28px) so it matches
 * `RecycleScroller`'s `item-size`; indentation is 16px per depth level.
 */
withDefaults(
	defineProps<{
		label: string;
		depth: number;
		icon?: Component;
		hasChildren: boolean;
		expanded: boolean;
		selected?: boolean;
		loading?: boolean;
		/** Tailwind class for the node glyph, set by the tree from its kind. */
		iconClass?: string;
		/** Rendered as bare muted text beside the label, DBX-style. */
		childCount?: number;
		/** Green dot marking a connection whose socket is live. */
		connected?: boolean;
		connectedTitle?: string;
		/** Small pill after the label, e.g. a column's nullability. */
		badge?: { text: string; tone: "warning" | "muted" };
		/** Row tooltip, for details that do not fit in the label. */
		title?: string;
	}>(),
	{ selected: false, loading: false },
);

const emit = defineEmits<{ toggle: []; activate: [] }>();
</script>

<template>
	<div
		class="tree-row w-full"
		role="treeitem"
		:tabindex="0"
		:aria-expanded="hasChildren ? expanded : undefined"
		:aria-selected="selected"
		:data-selected="selected ? 'true' : undefined"
		:data-loading="loading ? 'true' : undefined"
		:style="{ paddingLeft: `calc(0.5rem + ${depth} * 16px)` }"
		:title="title"
		@click="emit('activate')"
		@keydown.enter.prevent="emit('activate')"
		@keydown.space.prevent="emit('activate')"
	>
		<button
			v-if="hasChildren"
			type="button"
			class="tree-twisty"
			:data-expanded="expanded ? 'true' : undefined"
			:aria-label="expanded ? `Collapse ${label}` : `Expand ${label}`"
			@click.stop="emit('toggle')"
		>
			<ChevronRight :size="12" aria-hidden="true" />
		</button>
		<span v-else class="tree-twisty" aria-hidden="true" />

		<!-- Spinner and glyph share one 12px leading slot, so a row does not
		     shift sideways when its subtree starts or finishes loading. -->
		<Loader
			v-if="loading"
			class="size-3.5 shrink-0 animate-spin text-muted-foreground"
			aria-hidden="true"
		/>
		<!-- Icon colour carries the node's kind, the way DBX does it, so a table
		     is findable without reading every label. -->
		<!-- `:is` is what actually swaps in the glyph; without it Vue treats the
		     tag as a literal <component> element and renders nothing. -->
		<component
			v-else-if="icon"
			:is="icon"
			class="size-3.5 shrink-0"
			:class="iconClass ?? 'text-muted-foreground'"
			aria-hidden="true"
		/>

		<span class="min-w-0 flex-1 truncate">{{ label }}</span>

		<span
			v-if="childCount"
			class="shrink-0 text-[10px] text-muted-foreground tabular-nums"
		>
			{{ childCount }}
		</span>

		<!-- `leading-none` and no block padding keep the pill inside the fixed
		     28px row, so the virtual scroller's arithmetic still holds. -->
		<span
			v-if="badge"
			class="shrink-0 rounded-sm px-1 text-[10px] leading-none"
			:class="badge.tone === 'warning' ? 'text-amber-500' : 'text-muted-foreground'"
		>
			{{ badge.text }}
		</span>

		<span
			v-if="connected"
			class="size-1.5 shrink-0 rounded-full bg-green-500"
			:title="connectedTitle"
		/>
	</div>
</template>