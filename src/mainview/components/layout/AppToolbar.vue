<script setup lang="ts">
import {
	Moon,
	PanelLeftClose,
	Play,
	Plus,
	Search,
	Settings,
	Sun,
} from "lucide-vue-next";
import { useTheme } from "../../composables/useTheme";
import { useToast } from "../../composables/useToast";
import { useConnectionsStore } from "../../stores/connections";
import { useTabsStore } from "../../stores/tabs";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";

const emit = defineEmits<{
	"new-connection": [];
	settings: [];
	"toggle-sidebar": [];
	"quick-open": [];
}>();

const NO_DRAG = "electrobun-webkit-app-region-no-drag";
const connections = useConnectionsStore();
const tabs = useTabsStore();
const { toast } = useToast();
const { theme, toggle: toggleTheme } = useTheme();


/**
 * Opens a query tab for the connection the sidebar has selected. Without a
 * live connection there is nothing to qualify SQL against, so this refuses
 * instead of opening a tab that cannot run.
 */
function newQuery(): void {
	const id = connections.activeId;
	if (!id || connections.status[id] !== "connected") {
		toast("Connect to a database first");
		return;
	}
	const config = connections.configs.find((entry) => entry.id === id);
	tabs.openQueryTab({
		connectionId: id,
		database: config?.database ?? "",
		schema:
			config?.dbType === "postgres" ? (config.defaultSchema || "public") : "",
		forceNew: true,
	});
}
</script>

<template>
	<header
		class="app-toolbar electrobun-webkit-app-region-drag"
	>
		<div :class="['flex items-center gap-1', NO_DRAG]">
			<Button
				variant="ghost"
				size="icon"
				aria-label="Quick open (Cmd/Ctrl+P)"
				:class="NO_DRAG"
				@click="emit('quick-open')"
			>
				<Search />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				aria-label="Toggle sidebar"
				:class="NO_DRAG"
				@click="emit('toggle-sidebar')"
			>
				<PanelLeftClose />
			</Button>
			<Separator orientation="vertical" class="mx-1 h-4" />
			<Button
				variant="ghost"
				:class="NO_DRAG"
				@click="emit('new-connection')"
			>
				<Plus />
				New Connection
			</Button>
			<Button variant="ghost" :class="NO_DRAG" @click="newQuery">
				<Play />
				New Query
			</Button>
		</div>

		<div class="flex-1 electrobun-webkit-app-region-drag"></div>

		<div :class="['flex items-center gap-1', NO_DRAG]">
			<Button
				variant="ghost"
				size="icon"
				aria-label="Toggle theme"
				:class="NO_DRAG"
				@click="toggleTheme"
			>
				<Sun v-if="theme === 'dark'" />
				<Moon v-else />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				aria-label="Settings"
				:class="NO_DRAG"
				@click="emit('settings')"
			>
				<Settings />
			</Button>
		</div>
	</header>
</template>
