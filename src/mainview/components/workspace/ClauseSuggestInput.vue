<script setup lang="ts">
/**
 * A clause field that looks like a token (`WHERE`, `ORDER BY`) in an accent
 * colour but holds raw SQL, with the column list one keystroke or one click
 * away.
 *
 * The shell is a token, the content is not: the value is a fragment the grid
 * appends to the statement (`id = '73ba…'`, `name ASC`), so this cannot be a
 * structured builder — the user needs operators, quotes and functions the
 * builder has no vocabulary for. What the builder did give them is the column
 * name, and typing `na` to find `name` is exactly the friction worth removing.
 * Hence the token shell plus a prefix-filtered suggestion list that inserts the
 * name into the text and leaves the rest of the fragment to the user.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Component } from "vue";
import { ChevronDown, X } from "lucide-vue-next";
import { cn } from "../../lib/cn";

/**
 * The run being completed is the identifier at the very end of the text, not
 * the whole string: `id = '73ba…'` ends mid-literal and its last identifier is
 * whatever the user is typing, not the clause around it.
 */
const LAST_IDENTIFIER = /[A-Za-z0-9_$]+$/;

/** A result set is a projection, so the list is bounded by the column count. */
const MAX_SUGGESTIONS = 200;

const props = withDefaults(
	defineProps<{
		/** Accent token shown left of the text: "WHERE" or "ORDER BY". */
		label: string;
		/** Lucide icon component for the left slot. */
		icon: Component;
		/** Tailwind text colour class for the icon+label, e.g. "text-info". */
		accent: string;
		modelValue: string;
		placeholder: string;
		/** Full column list offered in the dropdown. */
		columns: string[];
		/** SQL type per column, parallel to `columns`. Row's secondary text. */
		columnTypes: string[];
		/** Emitted on every accepted suggestion, so the parent can apply. */
		commitOnPick?: boolean;
	}>(),
	{ columns: () => [], columnTypes: () => [], commitOnPick: false },
);

const emit = defineEmits<{
	"update:modelValue": [value: string];
	/** Enter in the text field, and the clear button. */
	submit: [];
}>();

const root = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const open = ref(false);
const activeIndex = ref(0);

const active = computed(() => props.modelValue.trim().length > 0);

/** What the user has typed of the identifier under the caret, lowercased. */
const typedToken = computed(() => {
	const match = LAST_IDENTIFIER.exec(props.modelValue);
	return match === null ? "" : match[0].toLowerCase();
});

/**
 * Prefix matches on the trailing identifier only. A token that matches nothing
 * falls back to the full list rather than an empty box: no match usually means
 * the user is mid-word, and an empty list would look like a broken field.
 */
const suggestions = computed(() => {
	const prefix = typedToken.value;
	const hits = prefix
		? props.columns.filter((name) => name.toLowerCase().startsWith(prefix))
		: props.columns;
	const rows = hits.length > 0 ? hits : props.columns;
	return rows.slice(0, MAX_SUGGESTIONS);
});

/** The declared type, when the caller supplied one for this column. */
function typeOf(column: string): string {
	return props.columnTypes[props.columns.indexOf(column)] ?? "";
}

function show(): void {
	open.value = true;
	activeIndex.value = 0;
}

function close(): void {
	open.value = false;
	activeIndex.value = 0;
}

/**
 * Programmatic focus must not be mistaken for the user arriving at the field.
 *
 * `modelValue` is a prop, so it is still the pre-pick value until the next
 * flush. Focusing synchronously handed `onFocus` an EMPTY field, which is
 * exactly the "user is asking for suggestions" signal — so every pick closed
 * the list and reopened it on the same tick, and the next click stacked a
 * second column name onto the clause. Focus on the next tick instead, behind a
 * flag that swallows that one `onFocus`.
 */
let focusIsProgrammatic = false;

function refocus(): void {
	focusIsProgrammatic = true;
	void nextTick(() => {
		input.value?.focus();
		focusIsProgrammatic = false;
	});
}

/**
 * Replaces the identifier being typed, or appends when the text ends in
 * punctuation or whitespace — which is what a fresh `WHERE ` is.
 */
function pick(column: string): void {
	const text = props.modelValue;
	const match = LAST_IDENTIFIER.exec(text);
	const next =
		match === null ? `${text}${column} ` : `${text.slice(0, match.index)}${column}`;
	emit("update:modelValue", next);
	close();
	if (props.commitOnPick) emit("submit");
	// A pick is a click, so the option button took focus; hand it back so the
	// rest of the fragment can be typed without reaching for the mouse again.
	refocus();
}

/** Clearing is an edit like any other, so it commits the same way Enter does. */
function clear(): void {
	emit("update:modelValue", "");
	emit("submit");
	// Same race as `pick`: an empty field that regains focus is the "show me
	// suggestions" signal, so the flag has to cover this one too.
	refocus();
}

/** The input is fully controlled, so the value is read straight off the event. */
function onInput(event: Event): void {
	const target = event.target;
	if (target instanceof HTMLInputElement) emit("update:modelValue", target.value);
}

/**
 * Moves the caret into the field. The window shell owns the Cmd/Ctrl+L chord
 * but cannot reach an input nested inside a result, so it asks the grid, which
 * asks this field — the one thing the shell cannot do for itself.
 */
function focusInput(): void {
	input.value?.focus();
}

defineExpose({ focus: focusInput });

function move(step: number): void {
	const total = suggestions.value.length;
	if (total === 0) return;
	activeIndex.value = (activeIndex.value + step + total) % total;
}

function onKeydown(event: KeyboardEvent): void {
	switch (event.key) {
		case "ArrowDown":
			event.preventDefault();
			if (open.value) move(1);
			else show();
			return;
		case "ArrowUp":
			if (!open.value) return;
			event.preventDefault();
			move(-1);
			return;
		case "Escape":
			if (!open.value) return;
			// Kept out of the window dispatcher by preventing the default: the
			// chord this app owns elsewhere must not also dismiss a listbox.
			event.preventDefault();
			close();
			return;
		case "Enter": {
			const column = open.value ? suggestions.value[activeIndex.value] : undefined;
			if (column === undefined) {
				emit("submit");
				return;
			}
			event.preventDefault();
			pick(column);
			return;
		}
	}
}

/**
 * An empty field is a field being asked for, not one being edited. The
 * programmatic refocus after a pick or a clear is the exception: the user did
 * not arrive, the click did.
 */
function onFocus(): void {
	if (focusIsProgrammatic) return;
	if (props.modelValue.trim().length === 0) show();
}

/**
 * Focus leaving the field entirely dismisses the list. `relatedTarget` is null
 * when focus drops to nothing at all, which counts as outside.
 */
function onFocusOut(event: FocusEvent): void {
	const next = event.relatedTarget;
	if (next instanceof Node && root.value?.contains(next)) return;
	close();
}

/** The document listener is only alive while there is a list to dismiss. */
function onDocumentPointerDown(event: PointerEvent): void {
	if (root.value?.contains(event.target as Node)) return;
	close();
}

/** Typing narrows the list, so the highlight can fall off the end of it. */
watch(suggestions, (rows) => {
	if (activeIndex.value >= rows.length) activeIndex.value = 0;
});

watch(open, (isOpen) => {
	if (isOpen) document.addEventListener("pointerdown", onDocumentPointerDown);
	else document.removeEventListener("pointerdown", onDocumentPointerDown);
});

onBeforeUnmount(() => {
	document.removeEventListener("pointerdown", onDocumentPointerDown);
});

/** Keeps the highlighted row inside the scroller as the arrows walk it. */
watch(activeIndex, () => {
	const option = list.value?.children[activeIndex.value];
	if (option instanceof HTMLElement) option.scrollIntoView({ block: "nearest" });
});
</script>

<template>
	<div ref="root" class="relative flex min-w-0 flex-1 flex-col">
		<div
			class="flex min-h-0 flex-1 items-center gap-1 px-1.5"
			:class="cn(open && 'ring-1 ring-inset ring-ring')"
		>
			<component
				:is="icon"
				class="size-[0.825rem] shrink-0"
				:class="active ? accent : 'text-muted-foreground'"
				aria-hidden="true"
			/>
			<span class="shrink-0 text-[0.825rem] font-medium" :class="accent">
				{{ label }}
			</span>

			<input
				ref="input"
				:value="modelValue"
				spellcheck="false"
				autocomplete="off"
				autocorrect="off"
				autocapitalize="off"
				role="combobox"
				aria-autocomplete="list"
				:aria-expanded="open"
				:aria-label="`${label} expression`"
				class="h-[1.375rem] min-w-0 flex-1 bg-transparent px-0 text-[0.825rem] outline-none placeholder:text-muted-foreground"
				:placeholder="placeholder"
				@input="onInput"
				@keydown="onKeydown"
				@focus="onFocus"
				@focusout="onFocusOut"
			/>

			<button
				type="button"
				class="grid size-[1.1rem] shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
				:aria-label="`Suggest a column for ${label}`"
				:aria-expanded="open"
				@click="open ? close() : show()"
			>
				<ChevronDown class="size-[0.825rem]" aria-hidden="true" />
			</button>
			<button
				v-if="active"
				type="button"
				class="grid size-[1.1rem] shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
				:aria-label="`Clear ${label}`"
				@click="clear"
			>
				<X class="size-[0.825rem]" aria-hidden="true" />
			</button>
		</div>

		<div
			v-if="open && suggestions.length > 0"
			ref="list"
			role="listbox"
			:aria-label="`${label} columns`"
			class="bg-popover text-popover-foreground absolute left-0 top-full z-50 mt-1 max-h-56 min-w-full overflow-y-auto rounded-md border p-1 shadow-md"
		>
			<!-- `mousedown.prevent` keeps focus on the input. WebKit does not focus
			     a button on click, so without it the press blurs the input,
			     `onFocusOut` closes the list, and the row is gone before its click
			     ever fires. Chromium focuses the button, which hid this. -->
			<button
				v-for="(column, index) in suggestions"
				:key="column"
				type="button"
				role="option"
				:aria-selected="index === activeIndex"
				class="flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-xs"
				:class="index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'"
				@mousedown.prevent
				@mouseenter="activeIndex = index"
				@click="pick(column)"
			>
				<span class="truncate">{{ column }}</span>
				<span
					v-if="typeOf(column)"
					class="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground"
				>
					{{ typeOf(column) }}
				</span>
			</button>
		</div>
	</div>
</template>
