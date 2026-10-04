<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import ConnectionDialog from "./components/dialogs/ConnectionDialog.vue";
import AppSidebar from "./components/sidebar/AppSidebar.vue";
import SqlFilesPanel from "./components/files/SqlFilesPanel.vue";
import QueryWorkspace from "./components/workspace/QueryWorkspace.vue";
import AppToolbar from "./components/layout/AppToolbar.vue";
import ToastHost from "./components/layout/ToastHost.vue";
import SnippetsSettings from "./components/editor/SnippetsSettings.vue";
import QuickOpenDialog from "./components/quickopen/QuickOpenDialog.vue";
import { useQuickOpen } from "./composables/useQuickOpen";
import { Button } from "./components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./components/ui/dialog";
import { useTheme } from "./composables/useTheme";
import { useToast } from "./composables/useToast";
import { rpc } from "./lib/rpc";
import { useTabsStore } from "./stores/tabs";
import { useConnectionsStore } from "./stores/connections";
import { useBookmarksStore } from "./stores/bookmarks";

const tabs = useTabsStore();
// Bookmarks are hydrated once, here: the editor's gutter and the window-level
// `Mod-<character>` jump both read this one store, and the backend is the only
// side that knows the mapping.
const bookmarks = useBookmarksStore();

/** The 36 characters a mnemonic can be; one slot each, no more. */
const MNEMONICS = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * CodeMirror's `Mod` is Cmd on macOS and Ctrl everywhere else. The binding
 * this handler replaces was spelled in `Mod`, so the same platform test decides
 * which key means "jump" here.
 */
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

const { theme, toggle } = useTheme();

const { toast } = useToast();

// Profiles live in the Bun process's SQLite file, so the sidebar's list only
// exists once the backend answers. Hydrating here covers every consumer of the
// store, and the tree holds its empty state back until it finishes.
void useConnectionsStore().hydrate();

// The bookmark list is backend-owned, so the jump handler and the editor's
// gutter both wait on the same load before they can know a mnemonic.
void bookmarks.load();

const connectionDialogOpen = ref(false);
/** Profile being edited, or null when the dialog is creating a new one. */
const connectionEditId = ref<string | null>(null);

/** Opening for a new profile always clears the edit target first. */
function openNewConnection(): void {
	connectionEditId.value = null;
	connectionDialogOpen.value = true;
}

function openEditConnection(connectionId: string): void {
	connectionEditId.value = connectionId;
	connectionDialogOpen.value = true;
}

const settingsOpen = ref(false);
const snippetsOpen = ref(false);
const quickOpen = useQuickOpen();

function onQuickOpenKeydown(event: KeyboardEvent): void {
	// Cmd/Ctrl+P is the print shortcut in every browser context, so the
	// palette takes it and the webview never sees the key.
	if (event.key !== "p" || !(event.metaKey || event.ctrlKey) || event.altKey) return;
	event.preventDefault();
	quickOpen.open.value = !quickOpen.open.value;
}

// Mnemonic jump for the whole window, following `onQuickOpenKeydown` above: a
// jump must work from anywhere in the app, and a CodeMirror keymap only ever
// sees a key while the editor itself holds focus — which is false when no query
// tab is open, when the active tab is a table tab, and when focus sits in the
// sidebar, the files panel or the result grid. So the shortcut lives here and
// asks the store to open whatever the character names.
//
// Only a character a bookmark is actually bound to is taken. An unbound one is
// left to the webview, `preventDefault` and all, because `Cmd-c`, `Cmd-v` and
// the rest have to keep working and a mnemonic set has no say over keys it does
// not own.
function onBookmarkJumpKeydown(event: KeyboardEvent): void {
	// `Alt` is not part of this chord, and a held key is one jump, not a stream.
	if (event.altKey || event.repeat) return;
	// Exactly the one accel key CodeMirror's `Mod` would have meant: Cmd on
	// macOS, Ctrl everywhere else, never both.
	const accel = IS_MAC ? event.metaKey : event.ctrlKey;
	if (!accel || (IS_MAC ? event.ctrlKey : event.metaKey)) return;
	// `Shift` is allowed either way — an uppercase letter names a mnemonic just
	// as well as a lowercase one does, so `key` is read as typed and lowered.
	const mnemonic = event.key.toLowerCase();
	if (mnemonic.length !== 1 || !MNEMONICS.includes(mnemonic)) return;
	if (!bookmarks.byMnemonic.has(mnemonic)) return;
	// Something closer to the key already spoke for it; a jump is not it.
	if (event.defaultPrevented) return;
	event.preventDefault();
	void bookmarks.jump(mnemonic);
}

const sidebarHidden = ref(false);
/** Right-hand SQL files panel visibility, toggled from the toolbar. */
const filesHidden = ref(false);

/** Mirrored from the panels' own resize handles; drives nothing but layout. */
const sidebarWidth = ref(260);
const filesWidth = ref(256);

function openSnippetsSettings(): void {
	settingsOpen.value = false;
	snippetsOpen.value = true;
}

/** The backend is the only side that can see a socket die on its own. */
function onConnectionLost(payload: { connectionId: string; reason: string }): void {
	toast(`Connection lost: ${payload.reason}`);
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
	if (tabs.tabs.some((tab) => tabs.isDirty(tab))) event.preventDefault();
}

onMounted(() => {
	rpc.addMessageListener("connectionLost", onConnectionLost);
	window.addEventListener("beforeunload", handleBeforeUnload);
	window.addEventListener("keydown", onQuickOpenKeydown);
	window.addEventListener("keydown", onBookmarkJumpKeydown);
});

onBeforeUnmount(() => {
	rpc.removeMessageListener("connectionLost", onConnectionLost);
	window.removeEventListener("beforeunload", handleBeforeUnload);
	window.removeEventListener("keydown", onQuickOpenKeydown);
	window.removeEventListener("keydown", onBookmarkJumpKeydown);
});
</script>

<template>
	<div
		class="recall-window-frame flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground"
	>
		<AppToolbar
			@new-connection="openNewConnection"
			@settings="settingsOpen = true"
			@toggle-sidebar="sidebarHidden = !sidebarHidden"
			@quick-open="quickOpen.open.value = !quickOpen.open.value"
			@toggle-files="filesHidden = !filesHidden"
		/>
		<div class="panel-gutter flex min-h-0 flex-1 gap-1 p-1">
			<AppSidebar
				v-show="!sidebarHidden"
				class="shrink-0"
				:style="{ width: `${sidebarWidth}px` }"
				@new-connection="openNewConnection"
				@edit-connection="openEditConnection"
				@resize="sidebarWidth = $event"
			/>
			<QueryWorkspace class="min-w-0 flex-1" />
			<!-- Docked right: the files list frames the workspace, and a drag
			     on its left edge does not fight the connections tree. -->
			<SqlFilesPanel
				v-show="!filesHidden"
				class="shrink-0"
				:style="{ width: `${filesWidth}px` }"
				@resize="filesWidth = $event"
			/>
		</div>
		<ConnectionDialog v-model:open="connectionDialogOpen" :edit-id="connectionEditId" />
		<SnippetsSettings v-model:open="snippetsOpen" />
		<QuickOpenDialog />

		<Dialog v-model:open="settingsOpen">
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Settings</DialogTitle>
					<DialogDescription>
						Appearance and workspace. Connections live in the sidebar.
					</DialogDescription>
				</DialogHeader>
				<div class="flex items-center justify-between border-t border-border pt-3">
					<span class="text-sm">Dark theme</span>
					<Button variant="outline" size="sm" @click="toggle">
						{{ theme === "dark" ? "On" : "Off" }}
					</Button>
				</div>
				<DialogFooter>
					<Button variant="outline" size="sm" @click="openSnippetsSettings">
						SQL snippets…
					</Button>
					<Button variant="destructive" @click="tabs.closeAll()">
						Close all tabs
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>

		<ToastHost />
	</div>
</template>
