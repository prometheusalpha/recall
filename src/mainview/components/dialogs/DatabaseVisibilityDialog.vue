<script setup lang="ts">
/**
 * Show or hide the databases of one connection.
 *
 * The dialog writes straight through to the profile: a switch is applied and
 * saved as it is flipped, so there is no draft and no Cancel to get wrong. What
 * it toggles is the profile's `hiddenDatabases`, which the sidebar reads when
 * it builds its database rows and Quick Open reads when it decides what to
 * chase — so one switch is enough to take a database out of both.
 *
 * A database that is hidden is not *disconnected*: a tab already open on it
 * keeps working, and the connection's own `database` cannot be hidden at all,
 * because it is the one the connection tested and the one the sidebar opens on.
 */
import { computed, ref, watch } from "vue";
import { Database, Loader2, RotateCw } from "lucide-vue-next";
import type { DatabaseInfo } from "@shared/types";
import { errorMessage } from "../../lib/rpc";
import { useTableCatalog } from "../../composables/useTableCatalog";
import { useConnectionsStore } from "../../stores/connections";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogScrollContent,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";

const props = defineProps<{
	open: boolean;
	/** The profile whose databases are being shown; null while none is picked. */
	connectionId: string | null;
}>();

const emit = defineEmits<{
	(e: "update:open", value: boolean): void;
	/**
	 * The hidden list of `connectionId` just changed. The sidebar has to hear
	 * about it: its cached database rows were built from the previous list, and
	 * nothing in the profile itself tells the tree to rebuild them.
	 */
	(e: "changed", connectionId: string): void;
}>();

const connections = useConnectionsStore();
const catalog = useTableCatalog();

const databases = ref<DatabaseInfo[]>([]);
const filter = ref("");
const loading = ref(false);
const failure = ref("");

const config = computed(() =>
	props.connectionId
		? connections.configs.find((entry) => entry.id === props.connectionId)
		: undefined,
);

/** The names kept out of the sidebar, as a lookup for the row switches. */
const hidden = computed(() => new Set(config.value?.hiddenDatabases ?? []));

/** The profile's own database. Never hideable; always the first row's peer. */
const ownDatabase = computed(() => config.value?.database ?? "");

const visible = computed(() => {
	const term = filter.value.trim().toLowerCase();
	if (term === "") return databases.value;
	return databases.value.filter((entry) =>
		entry.name.toLowerCase().includes(term),
	);
});

/**
 * Lists the server's databases, opening the session first when it is not up.
 *
 * `ensureConnected` is what makes the dialog usable from the context menu of a
 * profile that was never opened this session, and it is a no-op for one that
 * was — the menu does not force a connection, so it cannot be assumed.
 */
async function load(): Promise<void> {
	const id = props.connectionId;
	if (!id) return;
	loading.value = true;
	failure.value = "";
	try {
		await connections.ensureConnected(id);
		databases.value = await connections.listDatabases(id);
	} catch (err) {
		databases.value = [];
		failure.value = errorMessage(err);
	} finally {
		loading.value = false;
	}
}

watch(
	() => props.open,
	(open) => {
		if (!open) return;
		filter.value = "";
		databases.value = [];
		failure.value = "";
		void load();
	},
	{ immediate: true },
);

/**
 * One switch. Persisted immediately and broadcast twice: the profile list is
 * what the sidebar renders from, and the catalog is what the palette searches,
 * and neither notices a profile field changing behind its back.
 */
function setHidden(name: string, isHidden: boolean): void {
	const id = props.connectionId;
	const current = config.value;
	if (!id || !current) return;
	const next = new Set(current.hiddenDatabases);
	if (isHidden) next.add(name);
	else next.delete(name);
	connections.update(id, { hiddenDatabases: [...next] });
	// The palette's catalog was discovered with the previous list. Without this
	// a database hidden now stays searchable for the rest of its TTL.
	catalog.invalidate(id);
	emit("changed", id);
}

/** Show all: every database back, which is exactly an empty hidden list. */
function showAll(): void {
	applyAll([]);
}

/**
 * Hide all. The profile's own database is left out on purpose: a connection
 * with nothing to open is indistinguishable from a broken one.
 */
function hideAll(): void {
	applyAll(
		databases.value
			.map((entry) => entry.name)
			.filter((name) => name !== ownDatabase.value),
	);
}

function applyAll(names: string[]): void {
	const id = props.connectionId;
	if (!id || !config.value) return;
	connections.update(id, { hiddenDatabases: names });
	catalog.invalidate(id);
	emit("changed", id);
}
</script>

<template>
	<Dialog :open="open" @update:open="emit('update:open', $event)">
		<DialogScrollContent class="sm:max-w-[520px]">
			<DialogHeader>
				<DialogTitle>Databases</DialogTitle>
				<DialogDescription>
					Hidden databases leave the sidebar and stop appearing in search.
					Nothing is disconnected — a tab already open on one keeps working.
				</DialogDescription>
			</DialogHeader>

			<Input
				v-model="filter"
				placeholder="Filter databases"
				aria-label="Filter databases"
				spellcheck="false"
				:disabled="databases.length === 0"
			/>

			<div
				v-if="loading"
				class="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground"
			>
				<Loader2 class="size-4 animate-spin" aria-hidden="true" />
				Opening connection…
			</div>

			<div
				v-else-if="failure"
				class="space-y-2 rounded-md border border-destructive/40 px-3 py-2"
			>
				<p class="text-sm text-destructive">{{ failure }}</p>
				<div class="flex justify-end">
					<Button variant="outline" size="sm" @click="load">
						<RotateCw aria-hidden="true" />
						Retry
					</Button>
				</div>
			</div>

			<p
				v-else-if="databases.length === 0"
				class="px-1 py-6 text-center text-sm text-muted-foreground"
			>
				This server listed no databases.
			</p>

			<ScrollArea v-else class="max-h-72">
				<div class="flex flex-col pr-3">
					<div
						v-for="entry in visible"
						:key="entry.name"
						class="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/40"
					>
						<Database
							class="size-3.5 shrink-0 text-yellow-500"
							aria-hidden="true"
						/>
						<div class="min-w-0 flex-1">
							<p class="truncate text-sm">{{ entry.name }}</p>
							<p
								v-if="entry.comment"
								class="truncate text-xs text-muted-foreground"
								:title="entry.comment"
							>
								{{ entry.comment }}
							</p>
							<p
								v-else-if="entry.name === ownDatabase"
								class="text-xs text-muted-foreground"
							>
								Default database — always shown
							</p>
						</div>
						<Switch
							size="sm"
							:model-value="!hidden.has(entry.name)"
							:disabled="entry.name === ownDatabase"
							:aria-label="`Show ${entry.name}`"
							@update:model-value="(value) => setHidden(entry.name, !value)"
						/>
					</div>
					<p
						v-if="visible.length === 0"
						class="px-2 py-6 text-center text-sm text-muted-foreground"
					>
						No database matches “{{ filter }}”.
					</p>
				</div>
			</ScrollArea>

			<DialogFooter
				class="-mx-6 -mb-6 mt-2 flex-row justify-between rounded-b-md border-t border-border p-3 sm:rounded-b-md"
			>
				<div class="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						:disabled="databases.length === 0 || loading"
						@click="showAll"
					>
						Show all
					</Button>
					<Button
						variant="outline"
						size="sm"
						:disabled="databases.length === 0 || loading"
						@click="hideAll"
					>
						Hide all
					</Button>
				</div>
				<Button size="sm" @click="emit('update:open', false)">Done</Button>
			</DialogFooter>
		</DialogScrollContent>
	</Dialog>
</template>
