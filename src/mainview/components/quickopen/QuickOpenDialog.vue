<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { Component } from "vue";
import { FileCode2, Search, Server, Table2 } from "lucide-vue-next";
import { matchFuzzy } from "../../lib/fuzzy";
import { useQuickOpen, type QuickOpenItem } from "../../composables/useQuickOpen";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * The quick-open palette. Searchable list of tables, SQL files and
 * connections; picking a row opens it. State lives in the composable, not here,
 * so the window shell can open the palette without owning this component.
 */
const { open, query, items, searching, activate, close } = useQuickOpen();

/**
 * The row Enter would pick, held by id rather than by index. Rows stream in
 * while the fan-out runs, so the list is re-ranked under the reader several
 * times per search; an index would have to be re-thrown at row 0 on each of
 * those arrivals, which is what used to drag the scroll back to the top.
 */
const highlightedId = ref<string | null>(null);
const listRef = ref<HTMLElement | null>(null);

const ICON_BY_KIND: Record<QuickOpenItem["kind"], Component> = {
	table: Table2,
	file: FileCode2,
	connection: Server,
};

interface Segment {
	text: string;
	hit: boolean;
}

/**
 * Splits a label into matched and unmatched runs so only the matched
 * characters are emphasised. The indices come from the same matcher the
 * ranking used, so what is highlighted is exactly what was matched.
 */
function segments(label: string): Segment[] {
	const indices = new Set(matchFuzzy(query.value.trim(), label)?.indices ?? []);
	const parts: Segment[] = [];
	for (let index = 0; index < label.length; index += 1) {
		const hit = indices.has(index);
		const last = parts[parts.length - 1];
		if (last && last.hit === hit) last.text += label[index];
		else parts.push({ text: label[index], hit });
	}
	return parts;
}

/** Where the highlighted row sits in the current list; 0 when it is gone. */
const highlighted = computed(() => {
	const at = items.value.findIndex((item) => item.id === highlightedId.value);
	return at >= 0 ? at : 0;
});

const highlightedItem = computed<QuickOpenItem | null>(
	() => items.value[highlighted.value] ?? null,
);

/**
 * Brings the highlighted row into view, for the two things that move the
 * highlight on the user's behalf: a keystroke and an arrow key. Nothing else
 * calls it. Rows arriving from the fan-out re-rank the list under a reader who
 * is very likely looking at it, and scrolling for those is what pulled a
 * scrolled list out from under them.
 */
async function scrollToHighlight(): Promise<void> {
	await nextTick();
	listRef.value
		?.querySelector(`#quickopen-row-${highlighted.value}`)
		?.scrollIntoView({ block: "nearest" });
}

// A new query is the user's own doing, so the first row is where the highlight
// belongs. Clearing the id rather than the index: the previous id names a row
// the new ranking may still hold, and that row is not what was being pointed at.
watch(query, () => {
	highlightedId.value = null;
	void scrollToHighlight();
});

function move(delta: number): void {
	const count = items.value.length;
	if (count === 0) return;
	const next = (highlighted.value + delta + count) % count;
	highlightedId.value = items.value[next]?.id ?? null;
	void scrollToHighlight();
}

function onKeydown(event: KeyboardEvent): void {
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
			const item = highlightedItem.value;
			if (!item) return;
			event.preventDefault();
			void activate(item);
			break;
		}
		case "Escape":
			// The dialog would close on Escape anyway; going through `close`
			// also clears the query for the next open.
			event.preventDefault();
			close();
			break;
	}
}
</script>

<template>
	<Dialog :open="open" @update:open="open = $event">
		<DialogContent
			class="max-w-[calc(100%-2rem)] max-w-xl top-[15%] translate-y-0 gap-0 p-0 sm:max-w-xl"
			:show-close-button="false"
		>
			<DialogHeader class="sr-only">
				<DialogTitle>Search</DialogTitle>
				<DialogDescription class="sr-only">
					Search tables, SQL files and connections, then press Enter to open
					the highlighted one.
				</DialogDescription>
			</DialogHeader>

			<div class="flex items-center gap-2 border-b border-border px-3 py-2">
				<Search class="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<!-- An identifier is typed here, never prose: the squiggles
				     and autocapitalise only fight the query, and the fuzzy
				     rank reads the raw string back out of the box. -->
				<Input
					v-model="query"
					role="combobox"
					aria-label="Search tables, files and connections"
					aria-autocomplete="list"
					aria-expanded="true"
					aria-controls="quickopen-listbox"
					:aria-activedescendant="
						highlightedItem ? `quickopen-row-${highlighted}` : undefined
					"
					autofocus
					spellcheck="false"
					autocapitalize="off"
					autocorrect="off"
					placeholder="Search tables, files and connections…"
					class="h-7 border-0 px-1 py-0 focus-visible:ring-0"
					@keydown="onKeydown"
				/>
			</div>

			<div
				id="quickopen-listbox"
				ref="listRef"
				role="listbox"
				aria-label="Search results"
				class="recall-scroll max-h-[50vh] overflow-y-auto p-1"
			>
				<p
					v-if="items.length === 0"
					class="px-3 py-6 text-center text-sm text-muted-foreground"
				>
					{{ searching ? "Searching every connection…" : "No matches" }}
				</p>

				<div
					v-for="(item, index) in items"
					:key="item.id"
					:id="`quickopen-row-${index}`"
					role="option"
					:aria-selected="index === highlighted"
					class="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5"
					:class="
						index === highlighted
							? 'bg-accent text-accent-foreground'
							: 'text-foreground'
					"
					@click="activate(item)"
					@mouseenter="highlightedId = item.id"
				>
					<component
						:is="ICON_BY_KIND[item.kind]"
						class="h-4 w-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-semibold">
							<template v-for="(part, partIndex) in segments(item.label)" :key="partIndex">
								<span
									v-if="part.hit"
									class="font-bold text-warning"
								>{{ part.text }}</span>
								<template v-else>{{ part.text }}</template>
							</template>
						</span>
						<span class="block truncate text-xs text-muted-foreground">
							{{ item.description }}
						</span>
					</span>
				</div>
			</div>
		</DialogContent>
	</Dialog>
</template>
