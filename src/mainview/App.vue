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

const tabs = useTabsStore();
const { theme, toggle } = useTheme();

const { toast } = useToast();

// Profiles live in the Bun process's SQLite file, so the sidebar's list only
// exists once the backend answers. Hydrating here covers every consumer of the
// store, and the tree holds its empty state back until it finishes.
void useConnectionsStore().hydrate();

const connectionDialogOpen = ref(false);
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
const sidebarHidden = ref(false);

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
});

onBeforeUnmount(() => {
	rpc.removeMessageListener("connectionLost", onConnectionLost);
	window.removeEventListener("beforeunload", handleBeforeUnload);
	window.removeEventListener("keydown", onQuickOpenKeydown);
});
</script>

<template>
	<div
		class="recall-window-frame flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground"
	>
		<AppToolbar
			@new-connection="connectionDialogOpen = true"
			@settings="settingsOpen = true"
			@toggle-sidebar="sidebarHidden = !sidebarHidden"
			@quick-open="quickOpen.open.value = !quickOpen.open.value"
		/>
		<div class="panel-gutter flex min-h-0 flex-1 gap-1 p-1">
			<AppSidebar
				v-show="!sidebarHidden"
				class="shrink-0"
				:style="{ width: `${sidebarWidth}px` }"
				@resize="sidebarWidth = $event"
			/>
			<QueryWorkspace class="min-w-0 flex-1" />
			<!-- Docked right: the files list frames the workspace, and a drag
			     on its left edge does not fight the connections tree. -->
			<SqlFilesPanel
				class="shrink-0"
				:style="{ width: `${filesWidth}px` }"
				@resize="filesWidth = $event"
			/>
		</div>
		<ConnectionDialog v-model:open="connectionDialogOpen" />
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
