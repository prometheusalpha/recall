<script setup lang="ts">
/**
 * A hash as a field/value table over the pages loaded so far, with one editor
 * below it for the selected or new field. Renaming a field is a save with a
 * different name: the backend drops the old field in the same transaction.
 */
import { Plus, Save, Trash2 } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import type { RedisBytes, RedisHashEntry } from "../../../shared/redis";
import { bytesId } from "../../lib/redisFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const props = defineProps<{
	entries: RedisHashEntry[];
	/** `HLEN`, which may exceed what has been loaded. */
	length: number;
	hasMore: boolean;
	busy: boolean;
}>();

const emit = defineEmits<{
	(e: "loadMore"): void;
	(e: "save", change: { field: RedisBytes; value: string; previousField?: RedisBytes }): void;
	(e: "remove", field: RedisBytes): void;
}>();

const filter = ref("");
const visible = computed(() => {
	const term = filter.value.trim().toLowerCase();
	if (!term) return props.entries;
	return props.entries.filter(
		(entry) =>
			entry.field.text.toLowerCase().includes(term) ||
			entry.value.text.toLowerCase().includes(term),
	);
});

/** `null` edits nothing; "new" is an unsaved field. */
const editingId = ref<string | null>(null);
const fieldText = ref("");
const valueText = ref("");

const editing = computed(() =>
	props.entries.find((entry) => bytesId(entry.field) === editingId.value),
);
/** Binary bytes cannot round-trip through a text box, so they stay read-only. */
const readOnly = computed(
	() => editing.value !== undefined && (editing.value.field.base64 !== undefined || editing.value.value.base64 !== undefined),
);

function select(entry: RedisHashEntry): void {
	editingId.value = bytesId(entry.field);
	fieldText.value = entry.field.text;
	valueText.value = entry.value.text;
}

function startNew(): void {
	editingId.value = "new";
	fieldText.value = "";
	valueText.value = "";
}

// A reload that no longer has the edited field closes the editor.
watch(
	() => props.entries,
	() => {
		if (editingId.value !== null && editingId.value !== "new" && !editing.value) {
			editingId.value = null;
		}
	},
);

function save(): void {
	if (fieldText.value === "") return;
	emit("save", {
		field: { text: fieldText.value },
		value: valueText.value,
		previousField: editing.value?.field,
	});
	if (editingId.value === "new") editingId.value = bytesId({ text: fieldText.value });
}
</script>

<template>
	<div class="flex h-full min-h-0 flex-col">
		<div class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
			<Input v-model="filter" class="h-6 max-w-56 text-xs" placeholder="Filter loaded fields" aria-label="Filter fields" />
			<span class="text-xs text-muted-foreground tabular-nums">
				{{ entries.length }} of {{ length }} fields
			</span>
			<Button v-if="hasMore" variant="ghost" size="xs" :disabled="busy" @click="emit('loadMore')">Load more</Button>
			<Button variant="ghost" size="xs" class="ml-auto" @click="startNew">
				<Plus aria-hidden="true" />
				Add field
			</Button>
		</div>

		<div class="recall-scroll min-h-0 flex-1 overflow-auto">
			<table class="w-full table-fixed border-collapse font-mono text-xs">
				<thead class="sticky top-0 bg-chrome text-left text-muted-foreground">
					<tr>
						<th class="w-2/5 border-b border-border px-2 py-1 font-medium">Field</th>
						<th class="border-b border-border px-2 py-1 font-medium">Value</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="entry in visible"
						:key="bytesId(entry.field)"
						class="cursor-pointer hover:bg-muted"
						:class="{ 'bg-accent text-accent-foreground': bytesId(entry.field) === editingId }"
						@click="select(entry)"
					>
						<td class="truncate border-b border-border px-2 py-1" :title="entry.field.text">{{ entry.field.text }}</td>
						<td class="truncate border-b border-border px-2 py-1" :title="entry.value.text">{{ entry.value.text }}</td>
					</tr>
				</tbody>
			</table>
		</div>

		<form v-if="editingId !== null" class="flex shrink-0 flex-col gap-1.5 border-t border-border p-2" @submit.prevent="save">
			<Input v-model="fieldText" class="h-7 font-mono text-xs" placeholder="Field" aria-label="Field name" :readonly="readOnly" />
			<textarea
				v-model="valueText"
				rows="4"
				class="recall-scroll w-full resize-y rounded-md border border-input bg-transparent p-2 font-mono text-xs outline-none focus-visible:border-ring"
				placeholder="Value"
				aria-label="Field value"
				spellcheck="false"
				:readonly="readOnly"
			/>
			<div class="flex items-center gap-1">
				<span v-if="readOnly" class="text-xs text-muted-foreground">Binary field, shown escaped; edit it from the console.</span>
				<Button
					v-if="editing"
					type="button"
					variant="destructive"
					size="xs"
					:disabled="busy"
					@click="emit('remove', editing.field)"
				>
					<Trash2 aria-hidden="true" />
					Delete field
				</Button>
				<span class="flex-1" />
				<Button type="button" variant="ghost" size="xs" @click="editingId = null">Close</Button>
				<Button type="submit" size="xs" :disabled="busy || readOnly || fieldText === ''">
					<Save aria-hidden="true" />
					Save
				</Button>
			</div>
		</form>
	</div>
</template>
