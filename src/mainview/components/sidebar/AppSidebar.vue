<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
	ChevronsUp,
	PanelLeftClose,
	PanelLeftOpen,
	Plus,
} from "lucide-vue-next";
import ConnectionTree from "./ConnectionTree.vue";
import { Button } from "../ui/button";
import { usePanelResize } from "../../composables/usePanelResize";

/** Width at or below which the sidebar shows only its icon strip. */
const COLLAPSED_WIDTH = 40;

/** Width restored when the collapsed strip is opened again. */
const RESTORED_WIDTH = 260;

const emit = defineEmits<{
	(e: "new-connection"): void;
	/** New width in pixels, emitted on every change so the shell can react. */
	(e: "resize", width: number): void;
}>();

/** The shape `ConnectionTree` exposes via `defineExpose`. */
interface TreeHandle {
	collapseAll: () => void;
}

// Typed as `object` so any component instance fits; the exposed method is
// recovered by the cast in `collapseAll`, which keeps this file compiling
// whether or not the SFC's own types are visible here.
const tree = ref<object | null>(null);

const { width, startResize } = usePanelResize("sidebar", RESTORED_WIDTH, {
	min: 180,
	max: 520,
	side: "left",
});

const collapsed = computed(() => width.value <= COLLAPSED_WIDTH);

// The sidebar owns its width; the shell is told about changes rather than
// driving them, so the drag, the persisted value and the icon strip can never
// disagree about what the current width is.
watch(width, (value) => emit("resize", value));

function collapseAll(): void {
	(tree.value as TreeHandle | null)?.collapseAll();
}

function collapse(): void {
	width.value = COLLAPSED_WIDTH;
}

function restore(): void {
	width.value = RESTORED_WIDTH;
}
</script>

<template>
	<aside
		class="panel relative flex shrink-0 flex-col"
		:style="{ width: `${width}px` }"
	>
		<!-- The collapsed strip and the tree are siblings, not branches: both
		     stay mounted so expanding the sidebar restores the exact tree
		     state, caches included, without another round of fetches. -->
		<div
			v-if="collapsed"
			class="flex h-10 shrink-0 items-center justify-center border-b border-border bg-sidebar-header"
		>
			<Button
				size="icon"
				variant="ghost"
				class="h-6 w-6"
				aria-label="Expand sidebar"
				@click="restore"
			>
				<PanelLeftOpen aria-hidden="true" />
			</Button>
		</div>
		<div v-show="!collapsed" class="flex min-h-0 flex-1 flex-col">
			<div class="sidebar-header">
				<span class="flex-1">Connections</span>
				<Button
					size="icon"
					variant="ghost"
					class="h-6 w-6"
					aria-label="New connection"
					@click="emit('new-connection')"
				>
					<Plus aria-hidden="true" />
				</Button>
				<Button
					size="icon"
					variant="ghost"
					class="h-6 w-6"
					aria-label="Collapse all"
					@click="collapseAll"
				>
					<ChevronsUp aria-hidden="true" />
				</Button>
				<Button
					size="icon"
					variant="ghost"
					class="h-6 w-6"
					aria-label="Collapse sidebar"
					@click="collapse"
				>
					<PanelLeftClose aria-hidden="true" />
				</Button>
			</div>
			<ConnectionTree
				ref="tree"
				class="min-h-0 flex-1"
				@new-connection="emit('new-connection')"
			/>
		</div>
		<div
			class="panel-resize-handle panel-resize-handle--right"
			@pointerdown="startResize"
		/>
	</aside>
</template>