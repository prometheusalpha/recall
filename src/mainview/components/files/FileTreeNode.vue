<script setup lang="ts">
import {
	ChevronRight,
	FileCode2,
	FileText,
	Folder,
	FolderOpen,
} from "lucide-vue-next";
import type { Component } from "vue";
import { computed, nextTick, ref, watch } from "vue";
import type { SqlFileNode } from "../../../shared/sqlFile";

/**
 * One row of the SQL file tree, rendered recursively.
 *
 * Presentational only: the panel owns the folder list, the expansion set, the
 * datasource bindings and the rename in progress, and this row reports clicks,
 * twisty clicks, right-clicks and the committed name upward. Events bubble from
 * children, so the panel has a single handler per kind rather than one per
 * level of the tree.
 *
 * Height comes from the prewritten `.tree-row` (28px) and indentation is
 * 14px per depth level, matching `sidebar/TreeRow.vue` exactly — the two trees
 * sit side by side and must line up.
 */
const props = withDefaults(
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
		/**
		 * The path of the one row being renamed inline, or null. The panel owns
		 * it: a row asks to be renamed, it never decides that it is.
		 */
		renamingPath: string | null;
	}>(),
	{ expanded: false, activePath: null, renamingPath: null },
);

const emit = defineEmits<{
	toggle: [path: string];
	activate: [node: SqlFileNode];
	/** Right-click: the panel opens the context menu anchored to this path. */
	menu: [node: SqlFileNode, event: MouseEvent];
	/** The inline rename field was committed — Enter, or the field losing focus. */
	"commit-rename": [path: string, name: string];
	/** Escape: the row goes back to showing its name, untouched. */
	"cancel-rename": [path: string];
}>();

/** True while the panel has this exact row in rename mode. */
const renaming = computed(() => props.renamingPath === props.node.path);

const renameField = ref<HTMLInputElement | null>(null);
const draftName = ref("");

/**
 * Focus and select as the field appears, so typing replaces the name instead
 * of appending to it. Watched on the mode, not on the name: the panel sets the
 * path when the menu item is picked, and the row the user was on then swaps.
 */
watch(renaming, async (active) => {
	if (!active) return;
	draftName.value = props.node.name;
	await nextTick();
	renameField.value?.focus();
	renameField.value?.select();
});

/**
 * Enter commits and a lost focus commits, so a click anywhere else is a
 * commit rather than a silently discarded edit. Escape is the way out.
 */
function commitRename(): void {
	if (!renaming.value) return;
	emit("commit-rename", props.node.path, draftName.value);
}

function cancelRename(): void {
	if (!renaming.value) return;
	emit("cancel-rename", props.node.path);
}

/** `.sql` files get the code glyph; anything else the plain document glyph. */
function iconFor(node: SqlFileNode): Component {
	return isSql(node.name) ? FileCode2 : FileText;
}

/** One predicate for the glyph and the tint, so the two can never disagree. */
function isSql(name: string): boolean {
	return name.toLowerCase().endsWith(".sql");
}

/**
 * Icon tint. Folders and SQL files carry the same amber/blue the connection
 * tree uses for its nodes, so the two panels read as one surface; any other
 * file keeps the muted grey it had before there was a palette at all.
 */
const iconClass = computed(() =>
	props.node.isDir ? "text-amber-500" : isSql(props.node.name) ? "text-blue-500" : "text-muted-foreground",
);

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
				class="size-3 shrink-0"
				:class="iconClass"
				aria-hidden="true"
			/>

			<!-- The field stands in for the label, at the row's own height and
			     past the same twisty slot, so a rename does not shift the tree. -->
			<input
				v-if="renaming"
				ref="renameField"
				v-model="draftName"
				type="text"
				class="h-5 min-w-0 flex-1 rounded border border-ring bg-transparent px-1 text-[0.8125rem] outline-none"
				:aria-label="`Rename ${node.name}`"
				spellcheck="false"
				autocomplete="off"
				@click.stop
				@keydown.enter.prevent.stop="commitRename"
				@keydown.esc.prevent.stop="cancelRename"
				@blur="commitRename"
			/>
			<span v-else class="min-w-0 flex-1 truncate">{{ node.name }}</span>
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
				:renaming-path="renamingPath"
				@toggle="emit('toggle', $event)"
				@activate="emit('activate', $event)"
				@menu="(childNode, event) => emit('menu', childNode, event)"
				@commit-rename="(path, name) => emit('commit-rename', path, name)"
				@cancel-rename="(path) => emit('cancel-rename', path)"
			/>
		</div>
	</div>
</template>
