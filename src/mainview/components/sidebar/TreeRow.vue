<script setup lang="ts">
import { computed } from "vue";
import { ChevronRight, Loader } from "lucide-vue-next";
import type { Component } from "vue";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/**
 * One row of the connection tree. Presentational only: the parent owns
 * expansion, selection and loading, and this row just reports clicks.
 *
 * Height comes from the prewritten `.tree-row` (28px) so it matches
 * `RecycleScroller`'s `item-size`; indentation is 16px per depth level.
 *
 * The label is truncated to the sidebar's width, so a long table or column
 * name is unreadable. It used to fall back on a native `title` attribute,
 * which WebKit renders as a single line and clips at the screen edge — the
 * one case where the user most wants the rest of the string is the case where
 * they got the least of it. The shadcn `TooltipContent` wraps instead.
 *
 * The trigger wraps the *label*, not the row div. The row div is the
 * interaction surface, and `TooltipTrigger` binds `click`, `focus`,
 * `pointerdown` and `blur` on whatever it wraps; parking a trigger on the row
 * would mean every activation and every keyboard focus of the tree also drove
 * tooltip state on the element the tree itself listens to. The label span is
 * where the truncation happens, so it is also the only element whose full text
 * the tooltip is about.
 */
const props = withDefaults(
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
		/** Weight class for the label, set by the tree from its kind. */
		labelClass?: string;
		/** Rendered as bare muted text beside the label, DBX-style. */
		childCount?: number;
		/** Green dot marking a connection whose socket is live. */
		connected?: boolean;
		connectedTitle?: string;
		/** Small pill after the label, e.g. a column's nullability. */
		badge?: { text: string; tone: "warning" | "muted" };
		/**
		 * Full text for the hover tooltip, shown when the label is cut off or
		 * carries detail beside it (a column comment, an index's key columns).
		 * Rendered through `TooltipContent`, never as a native `title`: the row
		 * div deliberately carries none, or the two would compete on one hover.
		 */
		title?: string;
		/**
		 * Whether a right-click on this row is ours to handle. Off by default so
		 * only the row kinds that actually have a menu suppress the browser's.
		 */
		contextable?: boolean;
	}>(),
	{ selected: false, loading: false, contextable: false },
);

/**
 * The tooltip body, or `undefined` when this row has nothing to say.
 *
 * The tree is virtualised, and every row that mounted a `Tooltip` would build
 * a `TooltipRoot` context, a popper anchor, a `TooltipTrigger` with five
 * pointer/focus listeners and a `TooltipContent` portal. `disabled` builds
 * all of that too, so the branch is chosen in the template instead: a row with
 * no title renders the bare label and no tooltip machinery at all.
 *
 * A whitespace-only `title` collapses to `undefined` for the same reason — an
 * empty tooltip is worse than none, since it costs the same context.
 */
const tooltipText = computed(() => {
	const text = props.title?.trim();
	return text ? text : undefined;
});

const emit = defineEmits<{
	toggle: [];
	activate: [];
	contextmenu: [event: MouseEvent];
}>();

function onContextMenu(event: MouseEvent): void {
	if (!props.contextable) return;
	// Both guards are scoped to rows we serve a menu for: the click must not
	// also activate the row, and the browser's own menu must stay out of the way.
	event.preventDefault();
	event.stopPropagation();
	emit("contextmenu", event);
}

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
		@click="emit('activate')"
		@contextmenu="onContextMenu"
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

		<!-- `as-child` means no wrapper element: the trigger's props and the five
		     listeners land on this span, so the row's flex arithmetic and the
		     fixed 28px height are untouched. -->
		<Tooltip v-if="tooltipText">
			<TooltipTrigger as-child>
				<span class="min-w-0 flex-1 truncate" :class="labelClass">{{ label }}</span>
			</TooltipTrigger>
			<!-- The primitive's own `max-w-xs` wraps a long identifier into four
			     short lines; the row has the sidebar's full width to spend. -->
			<TooltipContent class="max-w-lg">{{ tooltipText }}</TooltipContent>
		</Tooltip>
		<span v-else class="min-w-0 flex-1 truncate" :class="labelClass">{{ label }}</span>

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