<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Search } from "lucide-vue-next";
import type { FindInFilesMatch } from "../../../shared/findInFiles";
import { useFindInFiles } from "../../composables/useFindInFiles";
import { useSqlFilesStore } from "../../stores/sqlFiles";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * Find in Files, modelled on JetBrains' popup: query with Match case / Words /
 * Regex toggles, a file mask, and a flat list of matching lines with the file
 * on the right. Enter opens the file with the hit selected.
 */
const {
	open,
	query,
	caseSensitive,
	wholeWord,
	regex,
	mask,
	rows,
	truncated,
	error,
	searching,
	activate,
} = useFindInFiles();
const sqlFiles = useSqlFilesStore();

const highlighted = ref(0);
const listRef = ref<HTMLElement | null>(null);
const inputRef = ref<InstanceType<typeof Input> | null>(null);

const toggles = computed(() => [
	{ label: "Cc", title: "Match case (Alt+C)", model: caseSensitive },
	{ label: "W", title: "Words (Alt+W)", model: wholeWord },
	{ label: ".*", title: "Regex (Alt+X)", model: regex },
]);

/**
 * Alt chords matched on `code`: on macOS Option turns the key into a different
 * character (Alt+C types "ç"), so `key` never reads "c".
 */
const TOGGLE_BY_CODE: Record<string, typeof caseSensitive> = {
	KeyC: caseSensitive,
	KeyW: wholeWord,
	KeyX: regex,
};

const countLabel = computed(() => {
	if (rows.value.length === 0) return "";
	return `${rows.value.length}${truncated.value ? "+" : ""} ${rows.value.length === 1 ? "match" : "matches"}`;
});

interface Segment {
	text: string;
	hit: boolean;
}

function segments(row: FindInFilesMatch): Segment[] {
	const parts: Segment[] = [];
	let cursor = 0;
	for (const [start, end] of row.ranges) {
		if (start > cursor) parts.push({ text: row.text.slice(cursor, start), hit: false });
		parts.push({ text: row.text.slice(start, end), hit: true });
		cursor = end;
	}
	if (cursor < row.text.length) parts.push({ text: row.text.slice(cursor), hit: false });
	// Leading indentation is noise in a one-line preview; the hit is what matters.
	if (parts[0] && !parts[0].hit) parts[0].text = parts[0].text.trimStart();
	return parts;
}

function fileName(path: string): string {
	return path.split(/[/\\]/).pop() ?? path;
}

/** The path below whichever opened folder holds it, for the row's tooltip. */
function relativePath(path: string): string {
	const root = sqlFiles.folders.find((folder) => path.startsWith(`${folder}/`));
	return root ? path.slice(root.length + 1) : path;
}

async function scrollToHighlight(): Promise<void> {
	await nextTick();
	listRef.value
		?.querySelector(`#fif-row-${highlighted.value}`)
		?.scrollIntoView({ block: "nearest" });
}

// Every search replaces the whole list, so the old index points at nothing.
watch(rows, () => {
	highlighted.value = 0;
	if (listRef.value) listRef.value.scrollTop = 0;
});

// Reopening keeps the last query, selected so typing replaces it.
watch(open, async (isOpen) => {
	if (!isOpen) return;
	await nextTick();
	const el = (inputRef.value?.$el as HTMLInputElement | undefined) ?? null;
	el?.select();
});

function move(delta: number): void {
	const count = rows.value.length;
	if (count === 0) return;
	highlighted.value = (highlighted.value + delta + count) % count;
	void scrollToHighlight();
}

function onKeydown(event: KeyboardEvent): void {
	if (event.altKey && !event.metaKey && !event.ctrlKey) {
		const toggle = TOGGLE_BY_CODE[event.code];
		if (toggle) {
			event.preventDefault();
			toggle.value = !toggle.value;
			return;
		}
	}
	switch (event.key) {
		case "ArrowDown":
			event.preventDefault();
			move(1);
			break;
		case "ArrowUp":
			event.preventDefault();
			move(-1);
			break;
		case "Enter": {
			const row = rows.value[highlighted.value];
			if (!row) return;
			event.preventDefault();
			void activate(row);
			break;
		}
		case "Escape":
			event.preventDefault();
			open.value = false;
			break;
	}
}

const emptyMessage = computed(() => {
	if (sqlFiles.folders.length === 0) return "Open a folder in the Files panel to search it";
	if (!query.value) return "Type to search the opened folders";
	if (searching.value) return "Searching…";
	return "No matches";
});
</script>

<template>
	<Dialog :open="open" @update:open="open = $event">
		<DialogContent
			class="max-w-[calc(100%-2rem)] top-[10%] translate-y-0 gap-0 p-0 sm:max-w-3xl"
			:show-close-button="false"
			@keydown="onKeydown"
		>
			<DialogHeader class="sr-only">
				<DialogTitle>Find in Files</DialogTitle>
				<DialogDescription class="sr-only">
					Search the text of every file in the opened folders, then press
					Enter to open the highlighted match.
				</DialogDescription>
			</DialogHeader>

			<div class="flex items-center gap-2 border-b border-border px-3 py-2">
				<Search class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<Input
					ref="inputRef"
					v-model="query"
					role="combobox"
					aria-label="Find in files"
					aria-autocomplete="list"
					aria-expanded="true"
					aria-controls="fif-listbox"
					:aria-activedescendant="rows.length ? `fif-row-${highlighted}` : undefined"
					autofocus
					spellcheck="false"
					autocapitalize="off"
					autocorrect="off"
					placeholder="Find in files…"
					class="h-7 border-0 px-1 py-0 font-mono focus-visible:ring-0"
				/>
				<div class="flex shrink-0 items-center gap-0.5">
					<button
						v-for="toggle in toggles"
						:key="toggle.label"
						type="button"
						:title="toggle.title"
						:aria-label="toggle.title"
						:aria-pressed="toggle.model.value"
						class="h-6 min-w-6 rounded px-1 font-mono text-xs"
						:class="
							toggle.model.value
								? 'bg-primary text-primary-foreground'
								: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
						"
						@click="toggle.model.value = !toggle.model.value"
					>
						{{ toggle.label }}
					</button>
				</div>
			</div>

			<div class="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
				<label for="fif-mask" class="shrink-0 text-muted-foreground">File mask</label>
				<Input
					id="fif-mask"
					:model-value="mask ?? ''"
					spellcheck="false"
					autocapitalize="off"
					autocorrect="off"
					placeholder="*.sql, !test*.sql"
					class="h-6 flex-1 px-1.5 py-0 font-mono text-xs"
					@update:model-value="mask = String($event)"
				/>
				<span class="shrink-0 text-muted-foreground">{{ countLabel }}</span>
			</div>

			<div
				id="fif-listbox"
				ref="listRef"
				role="listbox"
				aria-label="Matches"
				class="recall-scroll max-h-[55vh] overflow-y-auto p-1"
			>
				<p v-if="error" class="whitespace-pre-wrap px-3 py-4 font-mono text-xs text-destructive">
					{{ error }}
				</p>
				<p
					v-else-if="rows.length === 0"
					class="px-3 py-6 text-center text-sm text-muted-foreground"
				>
					{{ emptyMessage }}
				</p>

				<template v-else>
				<div
					v-for="(row, index) in rows"
					:id="`fif-row-${index}`"
					:key="`${row.path}:${row.line}`"
					role="option"
					:aria-selected="index === highlighted"
					:title="`${relativePath(row.path)}:${row.line}`"
					class="flex cursor-default items-center gap-3 rounded px-2 py-1"
					:class="index === highlighted ? 'bg-accent text-accent-foreground' : 'text-foreground'"
					@click="activate(row)"
					@mouseenter="highlighted = index"
				>
					<span class="min-w-0 flex-1 truncate font-mono text-xs">
						<template v-for="(part, partIndex) in segments(row)" :key="partIndex">
							<span v-if="part.hit" class="rounded-[2px] bg-warning-bg font-semibold text-warning">{{ part.text }}</span>
							<template v-else>{{ part.text }}</template>
						</template>
					</span>
					<span class="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
						{{ fileName(row.path) }}:{{ row.line }}
					</span>
				</div>
				</template>
			</div>
		</DialogContent>
	</Dialog>
</template>
