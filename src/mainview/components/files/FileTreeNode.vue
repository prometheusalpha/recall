<script setup lang="ts">
import {
	ChevronRight,
	FileCode2,
	FileText,
	Folder,
	FolderOpen,
} from "lucide-vue-next";
import type { Component } from "vue";
import type { SqlFileNode } from "../../../shared/sqlFile";

/**
 * One row of the SQL file tree, rendered recursively.
 *
 * Presentational only: the panel owns the folder list, the expansion set and
 * the datasource bindings, and this row reports clicks, twisty clicks and
 * right-clicks upward. Events bubble from children, so the panel has a single
 * handler per kind rather than one per level of the tree.
 *
 * Height comes from the prewritten `.tree-row` (28px) and indentation is
 * 14px per depth level, matching `sidebar/TreeRow.vue` exactly — the two trees
 * sit side by side and must line up.
 */
withDefaults(
	defineProps<{
		node: SqlFileNode;
		depth: number;
		expanded: boolean;
		/**
		 * Every expanded path, so a descendant can report whether it is open.
		 * `expanded` alone only describes this row, which is enough for a flat
		 * list but not for recursion.
		 */
		expandedPaths: ReadonlySet<string>;
		activePath: string | null;
	}>(),
	{ expanded: false, activePath: null },
);

const emit = defineEmits<{
	toggle: [path: string];
	activate: [node: SqlFileNode];
	/** Right-click: the panel opens the context menu anchored to this path. */
	menu: [node: SqlFileNode, event: MouseEvent];
}>();

/** `.sql` files get the code glyph; anything else the plain document glyph. */
function iconFor(node: SqlFileNode): Component {
	return node.name.toLowerCase().endsWith(".sql") ? FileCode2 : FileText;
}

/** A collapsed directory shows the closed glyph, matching the twisty state. */
function directoryIconFor(expanded: boolean): Component {
	return expanded ? FolderOpen : Folder;
}
</script>

<template>
	<div role="treeitem" :aria-expanded="node.isDir ? expanded : undefined">
		<div
			class="tree-row w-full"
			:aria-selected="activePath === node.path"
			:data-selected="activePath === node.path ? 'true' : undefined"
			:style="{ paddingLeft: `calc(0.5rem + ${depth} * 14px)` }"
			@click="emit('activate', node)"
			@keydown.enter.prevent="emit('activate', node)"
			@keydown.space.prevent="emit('activate', node)"
			@contextmenu.prevent="emit('menu', node, $event)"
		>
			<button
				v-if="node.isDir"
				type="button"
				class="tree-twisty"
				:data-expanded="expanded ? 'true' : undefined"
				:aria-label="expanded ? `Collapse ${node.name}` : `Expand ${node.name}`"
				@click.stop="emit('toggle', node.path)"
			>
				<ChevronRight :size="12" aria-hidden="true" />
			</button>
			<span v-else class="tree-twisty" aria-hidden="true" />

			<component
				:is="node.isDir ? directoryIconFor(expanded) : iconFor(node)"
				class="size-3 shrink-0 text-muted-foreground"
				aria-hidden="true"
			/>

			<span class="min-w-0 flex-1 truncate">{{ node.name }}</span>
		</div>

		<!-- A directory with nothing under it was already dropped by the scan,
		     so every directory here has at least one child to render. -->
		<div v-if="node.isDir && expanded" role="group">
			<FileTreeNode
				v-for="child in node.children"
				:key="child.path"
				:node="child"
				:depth="depth + 1"
				:expanded="expandedPaths.has(child.path)"
				:expanded-paths="expandedPaths"
				:active-path="activePath"
				@toggle="emit('toggle', $event)"
				@activate="emit('activate', $event)"
				@menu="(childNode, event) => emit('menu', childNode, event)"
			/>
		</div>
	</div>
</template>
