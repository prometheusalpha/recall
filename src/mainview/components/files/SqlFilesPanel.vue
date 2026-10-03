<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
	Copy,
	FolderPlus,
	FolderSearch,
	PanelRightClose,
	PanelRightOpen,
} from "lucide-vue-next";
import type { ConnectionConfig } from "../../../shared/types";
import type { FileDatasource, SqlFileNode } from "../../../shared/sqlFile";
import { toast } from "../../composables/useToast";
import { errorMessage } from "../../lib/rpc";
import { resolveFileDatasource } from "../../lib/fileDatasource";
import { useConnectionsStore } from "../../stores/connections";
import { useSqlFilesStore } from "../../stores/sqlFiles";
import { useTabsStore } from "../../stores/tabs";
import { usePanelResize } from "../../composables/usePanelResize";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import FileTreeNode from "./FileTreeNode.vue";

/**
 * The "open folder" panel: a browseable tree of SQL files, each remembered
 * against the datasource it runs on.
 *
 * The list is deliberately NOT virtualised, unlike the sidebar's connection
 * tree. A folder of SQL files is tens of rows, not tens of thousands, and
 * recursion plus a virtualiser means fighting the scroller for no benefit. The
 * directories that *are* huge (`node_modules`, `dist`, `.git`, …) never reach
 * this panel: the scan drops them.
 */
const sqlFiles = useSqlFilesStore();
const connections = useConnectionsStore();
const tabs = useTabsStore();

const emit = defineEmits<{
	/** New width in pixels, emitted on every drag step so the shell can react. */
	resize: [width: number];
}>();

/** Width at or below which the panel shows only its icon strip. */
const COLLAPSED_WIDTH = 40;
/** Width restored when the collapsed strip is opened again. */
const RESTORED_WIDTH = 256;

const { width, startResize } = usePanelResize("files", RESTORED_WIDTH, {
	min: 180,
	max: 520,
	side: "right",
});

const collapsed = computed(() => width.value <= COLLAPSED_WIDTH);

/** The panel owns its width; the shell only reacts to changes. */
watch(width, (value) => emit("resize", value));

function collapse(): void {
	width.value = COLLAPSED_WIDTH;
}

function restore(): void {
	width.value = RESTORED_WIDTH;
}

/** The file whose tab is on screen, so its row can show as selected. */
const activePath = ref<string | null>(null);
/** The node the context menu was opened on, null while the menu is closed. */
const menuNode = ref<SqlFileNode | null>(null);
const menuOpen = ref(false);
/**
 * Virtual anchor for the context menu. `DropdownMenu` positions its content
 * against the trigger element, so a zero-size element parked at the pointer is
 * what puts the menu under the cursor rather than under the whole panel. The
 * menu is opened by the right-click handler, never by clicking this.
 */
const menuAnchor = ref({ x: 0, y: 0 });

/**
 * Files whose datasource was guessed rather than bound. Each is named once, so
 * the fallback is discoverable without nagging on every reopen.
 */
const warnedFallbacks = new Set<string>();

/** One root per opened folder, flattened so the panel renders a single list. */
const roots = computed(() =>
	sqlFiles.folders.flatMap((folder) => sqlFiles.trees[folder] ?? []),
);

const hasFolders = computed(() => sqlFiles.folders.length > 0);

/** One connection paired with one database it can open, for the submenu. */
interface DatasourceChoice {
	connection: ConnectionConfig;
	database: string;
}

const datasourceChoices = computed<DatasourceChoice[]>(() =>
	connections.configs.flatMap((connection) => {
		// A connection's own database is the one it is configured against; the
		// server-reported current database is the other one it can be at.
		const databases = new Set([connection.database]);
		const current = connections.databaseInfo[connection.id]?.currentDatabase;
		if (current) databases.add(current);
		return [...databases]
			.filter((database) => database.length > 0)
			.map((database) => ({ connection, database }));
	}),
);

onMounted(() => {
	// Restored folders have no tree yet, and there is no filesystem watcher, so
	// the first scan is kicked off here.
	for (const folder of sqlFiles.folders) void sqlFiles.refresh(folder);
});

async function openFolder(): Promise<void> {
	try {
		const picked = await sqlFiles.pickFolder();
		if (!picked) return;
		await sqlFiles.addFolder(picked);
	} catch (err) {
		toast(errorMessage(err));
	}
}

/** Rescans every open folder. Bound to the filter box committing a change. */
function applyFilter(): void {
	for (const folder of sqlFiles.folders) void sqlFiles.refresh(folder);
}

function onMenu(node: SqlFileNode, event: MouseEvent): void {
	if (node.isDir) return;
	menuNode.value = node;
	menuAnchor.value = { x: event.clientX, y: event.clientY };
	menuOpen.value = true;
}

/**
 * The datasource a file opens against: its binding when it has one, otherwise
 * the active connection's own database and schema.
 *
 * Returns null when no connection is configured at all, which is the one case
 * where the file cannot be opened. A binding whose connection has since been
 * deleted also falls through to the fallback rather than dead-ending.
 */
function resolveDatasource(path: string): FileDatasource | null {
	const resolution = resolveFileDatasource(
		path,
		sqlFiles.bindings,
		connections.configs,
		connections.activeId,
	);
	if (!resolution) return null;
	if (resolution.usedFallback && !warnedFallbacks.has(path)) {
		warnedFallbacks.add(path);
		const active = connections.configs.find(
			(c) => c.id === connections.activeId,
		);
		toast(
			`No datasource bound to this file — using ${(active ?? connections.configs[0]).name}. Set one from the toolbar above the editor.`,
			6000,
		);
	}
	return resolution.datasource;
}

/** Opens a file as a query tab against its bound (or fallback) datasource. */
async function onActivate(node: SqlFileNode): Promise<void> {
	if (node.isDir) {
		sqlFiles.toggleExpanded(node.path);
		return;
	}
	const datasource = resolveDatasource(node.path);
	if (!datasource) {
		toast("Add a connection first");
		return;
	}

	try {
		await connections.ensureConnected(datasource.connectionId);
		const { content } = await sqlFiles.read(node.path);
		const tab = tabs.openQueryTab({
			connectionId: datasource.connectionId,
			database: datasource.database,
			schema: datasource.schema,
			sql: content,
			path: node.path,
		});
		// The tabs store titles every query "Query"; a file's own name is far
		// more useful once several are open at once.
		tabs.rename(tab.id, node.name);
		activePath.value = node.path;
	} catch (err) {
		toast(errorMessage(err));
	}
}

/** Opens the file the context menu was opened on. */
function openFromMenu(): void {
	if (menuNode.value) void onActivate(menuNode.value);
}

/** Binds the file to the chosen datasource, then opens it against it. */
async function chooseDatasource(choice: DatasourceChoice): Promise<void> {
	const node = menuNode.value;
	if (!node) return;
	sqlFiles.setBinding(node.path, {
		connectionId: choice.connection.id,
		database: choice.database,
		schema:
			choice.connection.dbType === "mysql" ? "" : choice.connection.defaultSchema,
	});
	await onActivate(node);
}

async function reveal(): Promise<void> {
	const node = menuNode.value;
	if (!node) return;
	try {
		await sqlFiles.revealInFolder(node.path);
	} catch (err) {
		toast(errorMessage(err));
	}
}

async function copyPath(): Promise<void> {
	const node = menuNode.value;
	if (!node) return;
	try {
		await navigator.clipboard.writeText(node.path);
		toast("Path copied");
	} catch {
		toast("Could not copy the path");
	}
}
</script>

<template>
	<aside
		class="panel relative flex min-h-0 shrink-0 flex-col"
		:style="{ width: `${width}px` }"
	>
		<!-- The collapsed strip and the tree are siblings, not branches: both stay
		     mounted so reopening the panel restores the exact tree state, caches
		     included, without another round of directory listings. -->
		<div
			v-if="collapsed"
			class="flex h-10 shrink-0 items-center justify-center border-b border-border bg-sidebar-header"
		>
			<Button
				size="icon"
				variant="ghost"
				class="h-6 w-6"
				aria-label="Expand files panel"
				@click="restore"
			>
				<PanelRightOpen aria-hidden="true" />
			</Button>
		</div>
		<div v-show="!collapsed" class="flex min-h-0 flex-1 flex-col">
		<div class="sidebar-header">
			<span class="flex-1">Files</span>
			<Button
				size="icon"
				variant="ghost"
				class="h-6 w-6"
				aria-label="Open folder"
				@click="openFolder"
			>
				<FolderPlus aria-hidden="true" />
			</Button>
			<Button
				size="icon"
				variant="ghost"
				class="h-6 w-6"
				aria-label="Collapse files panel"
				@click="collapse"
			>
				<PanelRightClose aria-hidden="true" />
			</Button>
		</div>

		<div
			v-if="!hasFolders"
			class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center"
		>
			<p class="text-xs text-muted-foreground">No folder opened</p>
			<Button size="sm" @click="openFolder">Open folder</Button>
		</div>

		<template v-else>
			<!-- Outside the scroller, so it stays put while the rows scroll. -->
			<div class="flex shrink-0 items-center gap-1 px-2 py-1">
				<Input
					v-model="sqlFiles.filter"
					class="h-6 text-xs"
					placeholder="*.sql"
					aria-label="Filter SQL files by name"
					spellcheck="false"
					@change="applyFilter"
				/>
			</div>

			<div
				class="recall-scroll min-h-0 flex-1 overflow-y-auto"
				role="tree"
				aria-label="SQL files"
			>
				<p
					v-if="roots.length === 0"
					class="px-3 py-2 text-xs text-muted-foreground"
				>
					No files match the filter
				</p>
				<FileTreeNode
					v-for="node in roots"
					:key="node.path"
					:node="node"
					:depth="0"
					:expanded="sqlFiles.expanded.has(node.path)"
					:expanded-paths="sqlFiles.expanded"
					:active-path="activePath"
					@toggle="sqlFiles.toggleExpanded"
					@activate="onActivate"
					@menu="onMenu"
				/>
			</div>

			<DropdownMenu v-model:open="menuOpen">
				<!-- `as-child` hands the anchor element straight to the popper, so
				     the trigger IS the zero-size element. It is `fixed` because the
				     pointer coordinates are viewport-relative while the panel sits
				     offset inside the gutter. -->
				<DropdownMenuTrigger as-child>
					<span
						class="pointer-events-none fixed size-0"
						:style="{
							left: `${menuAnchor.x}px`,
							top: `${menuAnchor.y}px`,
						}"
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent class="w-56">
					<DropdownMenuItem @select="openFromMenu">Open</DropdownMenuItem>
					<DropdownMenuItem @select="reveal">
						<FolderSearch aria-hidden="true" />
						Reveal in Finder
					</DropdownMenuItem>
					<DropdownMenuItem @select="copyPath">
						<Copy aria-hidden="true" />
						Copy Path
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>Datasource</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuLabel>Run against</DropdownMenuLabel>
							<DropdownMenuItem
								v-for="choice in datasourceChoices"
								:key="`${choice.connection.id}:${choice.database}`"
								@select="chooseDatasource(choice)"
							>
								{{ choice.connection.name }} / {{ choice.database }}
							</DropdownMenuItem>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				</DropdownMenuContent>
			</DropdownMenu>
		</template>
		</div>
		<div
			class="panel-resize-handle panel-resize-handle--left"
			@pointerdown="startResize"
		/>
	</aside>
</template>
