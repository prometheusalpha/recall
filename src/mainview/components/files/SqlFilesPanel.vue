<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
	ClipboardPaste,
	Copy,
	CopyPlus,
	FilePlus2,
	FolderOpen,
	FolderPlus,
	FolderSearch,
	Pencil,
	Scissors,
	Trash2,
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
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
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

/**
 * Width the panel opens at. Hiding it is the toolbar's job now, so this is
 * just the starting width for the resize handle rather than a restore target.
 */
const DEFAULT_FILES_WIDTH = 256;

const { width, startResize } = usePanelResize("files", DEFAULT_FILES_WIDTH, {
	min: 180,
	max: 520,
	side: "right",
});

/** The panel owns its width; the shell only reacts to changes. */
watch(width, (value) => emit("resize", value));


/**
 * The file whose tab is on screen, so its row can show as selected. Derived
 * from the tabs rather than remembered here, so a rename follows the file and
 * a delete drops the highlight without this panel being told about either.
 */
const activePath = computed(() => tabs.activeTab?.path ?? null);

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
 * The directory the toolbar's create buttons act on: the one holding the row
 * the user last right-clicked or opened, null until they touch a row.
 */
const contextDir = ref<string | null>(null);
/** The create prompt: what is being made, where, and under what name. */
const createOpen = ref(false);
const createParent = ref("");
const createIsDir = ref(false);
const createName = ref("");
/** The pending delete, held until the confirmation is answered. */
const deleteTarget = ref<SqlFileNode | null>(null);

/** The directory holding `path`. Scan paths are absolute and `/`-separated. */
function parentOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index > 0 ? path.slice(0, index) : path;
}

/** The last segment of a path: what a row is called. */
function nameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Remembers which directory the user is working in. A file counts as its
 * directory, so "New file" after clicking a file lands beside it; an
 * unopened panel falls back to the first folder, which is where everything
 * in the tree lives anyway.
 */
function rememberContext(node: SqlFileNode): void {
	contextDir.value = node.isDir ? node.path : parentOf(node.path);
}

/** Where the toolbar's create buttons act, or null when no folder is open. */
function toolbarDir(): string | null {
	if (contextDir.value) return contextDir.value;
	return sqlFiles.folders[0] ?? null;
}

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
	rememberContext(node);
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
	rememberContext(node);
	if (node.isDir) {
		sqlFiles.toggleExpanded(node.path);
		return;
	}
	const datasource = resolveDatasource(node.path);
	if (!datasource) {
		toast("Add a connection first");
		return;
	}

	// Opening a file is a local read: no socket is dialled here, the connection
	// is asserted lazily by the query path when the tab is actually run.
	try {
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

/** Puts the row into inline rename; the row itself owns the field. */
function startRename(): void {
	const node = menuNode.value;
	if (!node) return;
	sqlFiles.renamingPath = node.path;
}

/**
 * Commits the inline rename. The field is torn down first: a refused name is
 * a toast, and the row keeps the name the backend still has, so leaving the
 * field open over a name that does not exist would be worse.
 */
async function commitRename(path: string, name: string): Promise<void> {
	if (sqlFiles.renamingPath !== path) return;
	sqlFiles.renamingPath = null;
	const next = name.trim();
	// An empty name is a cancellation, not a request to delete the file.
	if (next.length === 0 || next === nameOf(path)) return;
	try {
		await sqlFiles.renameEntry(path, next);
	} catch (err) {
		toast(errorMessage(err));
	}
}

function cancelRename(path: string): void {
	if (sqlFiles.renamingPath === path) sqlFiles.renamingPath = null;
}

function cutFromMenu(): void {
	const node = menuNode.value;
	if (node) sqlFiles.cut([node.path]);
}

function copyFromMenu(): void {
	const node = menuNode.value;
	if (node) sqlFiles.copy([node.path]);
}

/** Pastes into a directory: itself for a directory row, its parent for a file. */
async function pasteFromMenu(): Promise<void> {
	const node = menuNode.value;
	if (!node) return;
	const destination = node.isDir ? node.path : parentOf(node.path);
	try {
		await sqlFiles.paste(destination);
	} catch (err) {
		toast(errorMessage(err));
	}
}

async function duplicateFromMenu(): Promise<void> {
	const node = menuNode.value;
	if (!node) return;
	try {
		await sqlFiles.duplicateEntry(node.path);
	} catch (err) {
		toast(errorMessage(err));
	}
}

/** Opens the name prompt for a new file or folder under `parent`. */
function startCreate(parent: string, isDir: boolean): void {
	createParent.value = parent;
	createIsDir.value = isDir;
	createName.value = "";
	createOpen.value = true;
}

/** The directory row's own create items, which act on that directory. */
function createInMenu(isDir: boolean): void {
	const node = menuNode.value;
	if (!node || !node.isDir) return;
	startCreate(node.path, isDir);
}

/** The toolbar's create buttons, acting where the user last was. */
function startCreateHere(isDir: boolean): void {
	const parent = toolbarDir();
	if (!parent) {
		toast("Open a folder first");
		return;
	}
	startCreate(parent, isDir);
}

async function submitCreate(): Promise<void> {
	const name = createName.value.trim();
	if (name.length === 0) {
		toast("Name the new entry first");
		return;
	}
	createOpen.value = false;
	try {
		await sqlFiles.createEntry(createParent.value, name, createIsDir.value);
	} catch (err) {
		toast(errorMessage(err));
	}
}

/** Holds the row until the confirmation is answered; nothing is deleted yet. */
function askDelete(): void {
	deleteTarget.value = menuNode.value;
}

function setDeleteOpen(open: boolean): void {
	if (!open) deleteTarget.value = null;
}

async function confirmDelete(): Promise<void> {
	const node = deleteTarget.value;
	deleteTarget.value = null;
	// A nameless target is not a thing the tree can produce; refuse rather
	// than hand the backend an empty path to act on.
	if (!node || node.name.length === 0) return;
	try {
		await sqlFiles.deleteEntry(node.path);
	} catch (err) {
		toast(errorMessage(err));
	}
}
</script>

<template>
	<aside
		class="panel relative flex min-h-0 shrink-0 flex-col"
		:style="{ width: `${width}px` }"
	>
		<div class="sidebar-header">
			<span class="flex-1">Files</span>
			<Button
				size="icon"
				variant="ghost"
				class="h-6 w-6"
				aria-label="New file"
				@click="startCreateHere(false)"
			>
				<FilePlus2 aria-hidden="true" />
			</Button>
			<Button
				size="icon"
				variant="ghost"
				class="h-6 w-6"
				aria-label="New folder"
				@click="startCreateHere(true)"
			>
				<FolderPlus aria-hidden="true" />
			</Button>
			<Button
				size="icon"
				variant="ghost"
				class="h-6 w-6"
				aria-label="Open folder"
				@click="openFolder"
			>
				<FolderOpen aria-hidden="true" />
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
					:renaming-path="sqlFiles.renamingPath"
					@toggle="sqlFiles.toggleExpanded"
					@activate="onActivate"
					@menu="onMenu"
					@commit-rename="commitRename"
					@cancel-rename="cancelRename"
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
					<!-- A directory cannot be opened, revealed or bound to a
					     datasource, so its menu is about the directory itself. -->
					<template v-if="menuNode?.isDir">
						<DropdownMenuItem @select="createInMenu(false)">
							<FilePlus2 aria-hidden="true" />
							New file here…
						</DropdownMenuItem>
						<DropdownMenuItem @select="createInMenu(true)">
							<FolderPlus aria-hidden="true" />
							New folder here…
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem @select="cutFromMenu">
							<Scissors aria-hidden="true" />
							Cut
						</DropdownMenuItem>
						<DropdownMenuItem @select="copyFromMenu">
							<Copy aria-hidden="true" />
							Copy
						</DropdownMenuItem>
						<DropdownMenuItem
							:disabled="sqlFiles.clipboard === null"
							@select="pasteFromMenu"
						>
							<ClipboardPaste aria-hidden="true" />
							Paste
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem @select="startRename">
							<Pencil aria-hidden="true" />
							Rename…
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" @select="askDelete">
							<Trash2 aria-hidden="true" />
							Delete
						</DropdownMenuItem>
					</template>

					<template v-else>
						<DropdownMenuItem @select="openFromMenu">Open</DropdownMenuItem>
						<DropdownMenuItem @select="startRename">
							<Pencil aria-hidden="true" />
							Rename…
						</DropdownMenuItem>
						<DropdownMenuItem @select="duplicateFromMenu">
							<CopyPlus aria-hidden="true" />
							Duplicate
						</DropdownMenuItem>
						<DropdownMenuItem @select="cutFromMenu">
							<Scissors aria-hidden="true" />
							Cut
						</DropdownMenuItem>
						<DropdownMenuItem @select="copyFromMenu">
							<Copy aria-hidden="true" />
							Copy
						</DropdownMenuItem>
						<DropdownMenuSeparator />
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
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" @select="askDelete">
							<Trash2 aria-hidden="true" />
							Delete
						</DropdownMenuItem>
					</template>
				</DropdownMenuContent>
			</DropdownMenu>
		</template>

		<!-- Both dialogs live outside the tree so a scrolled panel never takes
		     the prompt with it. -->
		<Dialog v-model:open="createOpen">
			<DialogContent class="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{{ createIsDir ? "New folder" : "New file" }}</DialogTitle>
					<DialogDescription>
						{{ createIsDir
							? "Folders can be nested, and can hold other folders."
							: "SQL files show up in the tree as soon as they match the filter." }}
					</DialogDescription>
				</DialogHeader>

				<Input
					v-model="createName"
					:aria-label="createIsDir ? 'Folder name' : 'File name'"
					placeholder="queries.sql"
					spellcheck="false"
					autocomplete="off"
					@keydown.enter.prevent="submitCreate"
				/>

				<DialogFooter>
					<Button variant="ghost" @click="createOpen = false">Cancel</Button>
					<Button @click="submitCreate">Create</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>

		<Dialog :open="deleteTarget !== null" @update:open="setDeleteOpen">
			<DialogContent class="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Delete {{ deleteTarget?.name }}?</DialogTitle>
					<DialogDescription>
						{{ deleteTarget?.isDir
							? "The folder and everything inside it are removed. "
							: "" }}This cannot be undone.
					</DialogDescription>
				</DialogHeader>

				<DialogFooter>
					<Button variant="ghost" @click="deleteTarget = null">Cancel</Button>
					<Button variant="destructive" @click="confirmDelete">Delete</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
		<div
			class="panel-resize-handle panel-resize-handle--left"
			@pointerdown="startResize"
		/>
	</aside>
</template>
