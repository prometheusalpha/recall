<script setup lang="ts">
/**
 * Mnemonic snippet manager.
 *
 * A standalone dialog: the editor has no opinion about which snippets exist,
 * it only reads the store. Rows toggle and delete inline; creating or editing a
 * body goes through a nested dialog because a multi-line template does not fit
 * a table cell. Validation is inline next to the field, never a toast — a toast
 * disappears before the user can see which input is wrong.
 */
import { ref, watch } from "vue";
import { PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-vue-next";
import type { SqlSnippet } from "../../lib/sqlSnippets";
import { useSnippetsStore } from "../../stores/snippets";
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
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{
	(e: "update:open", value: boolean): void;
}>();

const snippetsStore = useSnippetsStore();

/** `null` = adding; a snippet = editing that one. */
const formOpen = ref(false);
const editingId = ref<string | null>(null);
const draftLabel = ref("");
const draftPrefix = ref("");
const draftBody = ref("");
const prefixError = ref("");
const bodyError = ref("");
const confirmingRestore = ref(false);

/**
 * The one built-in that expands to a statement with no `WHERE`, so it stays
 * flagged as destructive even after the user renames it.
 */
const DESTRUCTIVE_BUILTIN_ID = "builtin-updall";

function resetForm(): void {
	editingId.value = null;
	draftLabel.value = "";
	draftPrefix.value = "";
	draftBody.value = "";
	prefixError.value = "";
	bodyError.value = "";
}

watch(
	() => props.open,
	(open) => {
		if (open) confirmingRestore.value = false;
	},
);

function openAdd(): void {
	resetForm();
	formOpen.value = true;
}

function openEdit(snippet: SqlSnippet): void {
	resetForm();
	editingId.value = snippet.id;
	draftLabel.value = snippet.label;
	draftPrefix.value = snippet.prefix;
	draftBody.value = snippet.body;
	formOpen.value = true;
}

function submit(): void {
	prefixError.value = "";
	bodyError.value = "";
	const fields = {
		label: draftLabel.value,
		prefix: draftPrefix.value,
		body: draftBody.value,
	};
	// An edit must not carry `enabled`: patching it to `true` would silently
	// re-enable a snippet the user switched off in the table.
	const result = editingId.value
		? snippetsStore.update(editingId.value, fields)
		: snippetsStore.add({ ...fields, enabled: true });
	if (result.ok) {
		formOpen.value = false;
		resetForm();
		return;
	}
	// The store's rejection names the problem; the message names the field, so
	// the user does not have to guess which of the three inputs is at fault.
	if (result.reason === "empty-body") {
		bodyError.value = "A snippet without a body would expand to nothing.";
		return;
	}
	prefixError.value =
		result.reason === "duplicate-prefix"
			? `“${draftPrefix.value.trim()}” is already used by another snippet.`
			: "Prefix cannot be empty.";
}

function restoreDefaults(): void {
	snippetsStore.resetToDefaults();
	confirmingRestore.value = false;
}
</script>

<template>
	<Dialog
		:open="props.open"
		@update:open="emit('update:open', $event)"
	>
		<DialogScrollContent class="sm:max-w-[720px]">
			<DialogHeader>
				<DialogTitle>SQL snippets</DialogTitle>
				<DialogDescription>
					Type a prefix in the editor and accept the completion popup to
					expand it. Built-ins can be disabled, retitled or deleted.
				</DialogDescription>
			</DialogHeader>

			<div class="recall-scroll max-h-[46vh] overflow-auto rounded-md border border-border">
				<table class="w-full border-collapse text-sm">
					<caption class="sr-only">
						Snippets, with their label, prefix, status and body template
					</caption>
					<thead>
						<tr class="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
							<th scope="col" class="px-3 py-2 font-medium">Label</th>
							<th scope="col" class="px-3 py-2 font-medium">Prefix</th>
							<th scope="col" class="px-3 py-2 font-medium">Status</th>
							<th scope="col" class="px-3 py-2 font-medium">Body</th>
							<th scope="col" class="px-3 py-2 font-medium">
								<span class="sr-only">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						<tr
							v-for="snippet in snippetsStore.snippets"
							:key="snippet.id"
							class="border-b border-border last:border-b-0 align-top"
						>
							<td class="px-3 py-2">
								<span class="block font-medium">{{ snippet.label }}</span>
								<span
								v-if="snippet.id === DESTRUCTIVE_BUILTIN_ID"
									class="text-xs text-destructive"
								>
									No WHERE clause
								</span>
							</td>
							<td class="px-3 py-2">
								<code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">
									{{ snippet.prefix }}
								</code>
							</td>
							<td class="px-3 py-2 text-xs text-muted-foreground">
								{{ snippet.enabled ? "Enabled" : "Disabled" }}
							</td>
							<td class="px-3 py-2">
								<pre class="recall-scroll max-h-24 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">{{ snippet.body }}</pre>
							</td>
							<td class="px-3 py-2">
								<div class="flex items-center justify-end gap-1">
									<Switch
										size="sm"
										:checked="snippet.enabled"
										:aria-label="`${snippet.enabled ? 'Disable' : 'Enable'} snippet ${snippet.label}`"
										@update:checked="snippetsStore.toggleEnabled(snippet.id)"
									/>
									<Button
										variant="ghost"
										size="icon-sm"
										:aria-label="`Edit snippet ${snippet.label}`"
										@click="openEdit(snippet)"
									>
										<PencilIcon aria-hidden="true" />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										:aria-label="`Delete snippet ${snippet.label}`"
										@click="snippetsStore.remove(snippet.id)"
									>
										<Trash2Icon aria-hidden="true" />
									</Button>
								</div>
							</td>
						</tr>
						<tr v-if="snippetsStore.snippets.length === 0">
							<td colspan="5" class="px-3 py-6 text-center text-muted-foreground">
								No snippets. The editor will not offer any until you add one.
							</td>
						</tr>
					</tbody>
				</table>
			</div>

			<DialogFooter class="sm:justify-between">
				<Button variant="outline" size="sm" @click="openAdd">
					<PlusIcon aria-hidden="true" />
					Add snippet
				</Button>
				<Button
					v-if="!confirmingRestore"
					variant="ghost"
					size="sm"
					@click="confirmingRestore = true"
				>
					<RotateCcwIcon aria-hidden="true" />
					Restore defaults
				</Button>
				<div v-else class="flex items-center gap-2">
					<span class="text-xs text-destructive" role="status">
						Discard every custom snippet?
					</span>
					<Button variant="ghost" size="sm" @click="confirmingRestore = false">
						Cancel
					</Button>
					<Button variant="destructive" size="sm" @click="restoreDefaults">
						Restore
					</Button>
				</div>
			</DialogFooter>

			<Dialog :open="formOpen" @update:open="formOpen = $event">
				<DialogScrollContent class="sm:max-w-[560px]">
					<DialogHeader>
						<DialogTitle>{{ editingId ? "Edit snippet" : "New snippet" }}</DialogTitle>
						<DialogDescription>
							The body is a CodeMirror template: write
							<code class="font-mono">${1:placeholder}</code> to make a
							tab-stop, and Tab / Shift-Tab moves between them after the
							snippet is inserted.
						</DialogDescription>
					</DialogHeader>

					<div class="space-y-3">
						<div>
							<Label for="snippet-label">Label</Label>
							<Input
								id="snippet-label"
								v-model="draftLabel"
								placeholder="Shown in the completion popup"
								autocomplete="off"
							/>
						</div>
						<div>
							<Label for="snippet-prefix">Prefix</Label>
							<Input
								id="snippet-prefix"
								v-model="draftPrefix"
								placeholder="e.g. svt"
								autocomplete="off"
								:aria-invalid="Boolean(prefixError)"
								:aria-describedby="prefixError ? 'snippet-prefix-error' : 'snippet-prefix-hint'"
							/>
							<p
								v-if="prefixError"
								id="snippet-prefix-error"
								class="mt-1 text-xs text-destructive"
							>
								{{ prefixError }}
							</p>
							<p v-else id="snippet-prefix-hint" class="mt-1 text-xs text-muted-foreground">
								The mnemonic the user types. Must be unique.
							</p>
						</div>
						<div>
							<Label for="snippet-body">Body</Label>
							<textarea
								id="snippet-body"
								v-model="draftBody"
								rows="8"
								spellcheck="false"
								placeholder="SELECT ${1:column}&#10;FROM ${2:table};"
								class="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
								:aria-invalid="Boolean(bodyError)"
								:aria-describedby="bodyError ? 'snippet-body-error' : undefined"
							/>
							<p
								v-if="bodyError"
								id="snippet-body-error"
								class="mt-1 text-xs text-destructive"
							>
								{{ bodyError }}
							</p>
						</div>
					</div>

					<DialogFooter>
						<Button variant="ghost" @click="formOpen = false">Cancel</Button>
						<Button @click="submit">
							{{ editingId ? "Save" : "Add" }}
						</Button>
					</DialogFooter>
				</DialogScrollContent>
			</Dialog>
		</DialogScrollContent>
	</Dialog>
</template>
