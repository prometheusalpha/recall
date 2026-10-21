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
 *
 * The list therefore follows the caret through the fragment: it offers columns
 * where a field belongs, `AND`/`OR` once the expression is complete, and
 * nothing inside a quoted value, where the operand is the user's own text. All
 * of that reading lives in `lib/clauseSuggestion`, which keeps this file about
 * the input, the list and the keyboard.
 *
 * Tab or a click accepts a row. Enter accepts a COLUMN row while the list is
 * offering one, and otherwise runs the clause; an `AND`/`OR` list never takes
 * Enter, because it opens right after a complete expression — exactly when the
 * user means to run it.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Component } from "vue";
import { ChevronDown, X } from "lucide-vue-next";
import type { DatabaseType } from "../../../shared/types";
import {
	clauseConnectors,
	clauseFieldSuggestions,
	clausePick,
	clauseRole,
	clauseTarget,
	type ClauseKind,
} from "../../lib/clauseSuggestion";
import { IDENTIFIER_QUOTES } from "../../lib/sqlLexicon";

/** A result set is a projection, so the list is bounded by the column count. */
const MAX_SUGGESTIONS = 200;

/** One row of the list: what it writes, and the type shown beside the name. */
interface SuggestionRow {
	value: string;
	insertText: string;
	detail: string;
	connector: boolean;
}

const props = withDefaults(
	defineProps<{
		/** `where` can also offer connectors; `orderBy` is a field list. */
		kind: ClauseKind;
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
		/**
		 * Connection dialect, so a name the dialect cannot take bare is inserted
		 * quoted. Undefined leaves every name bare.
		 */
		dbType?: DatabaseType;
		/** Emitted on every accepted suggestion, so the parent can apply. */
		commitOnPick?: boolean;
		/** The last run was rejected at this clause, so the frame turns red. */
		invalid?: boolean;
	}>(),
	{
		columns: () => [],
		columnTypes: () => [],
		commitOnPick: false,
		invalid: false,
	},
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

/**
 * The frame around the field. The list being open and a rejected clause both
 * want it, and the rejection is the one the user cannot see from anywhere
 * else, so it wins.
 */
const frame = computed(() =>
	props.invalid
		? "ring-1 ring-inset ring-destructive"
		: open.value
			? "ring-1 ring-inset ring-ring"
			: "",
);

/**
 * The caret, mirrored from the element on every event that can move it. The
 * list reads the fragment where the user is typing, which is not always the end
 * of the value.
 */
const selection = ref({ start: 0, end: 0 });

const identifierQuote = computed(() =>
	props.dbType === undefined ? undefined : IDENTIFIER_QUOTES[props.dbType],
);

/** The declared type, when the caller supplied one for this column. */
function typeOf(column: string): string {
	return props.columnTypes[props.columns.indexOf(column)] ?? "";
}

/**
 * The rows for a fragment and a caret. Takes them explicitly rather than off
 * the props, because `onInput` runs before the parent has written the new value
 * back, and a list built from the previous keystroke flickers behind the text.
 */
function rowsFor(value: string, start: number, end: number): SuggestionRow[] {
	const target = clauseTarget(
		props.kind,
		value,
		start,
		end,
		identifierQuote.value,
	);
	const role = clauseRole(props.kind, target);
	if (role === "none") return [];
	if (role === "connector") {
		return clauseConnectors(target.token).map((keyword) => ({
			value: keyword,
			insertText: keyword,
			detail: "",
			connector: true,
		}));
	}
	return clauseFieldSuggestions({
		columns: props.columns,
		token: target.token,
		quotedIdentifier: target.quotedIdentifier,
		dbType: props.dbType,
	})
		.slice(0, MAX_SUGGESTIONS)
		.map((suggestion) => ({
			value: suggestion.column,
			insertText: suggestion.insertText,
			detail: typeOf(suggestion.column),
			connector: false,
		}));
}

const rows = computed(() =>
	rowsFor(props.modelValue, selection.value.start, selection.value.end),
);

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
 * flag that swallows that one `onFocus`, and put the caret where the pick left
 * off so the operator can be typed without reaching for the mouse.
 */
let focusIsProgrammatic = false;

function refocus(caret: number): void {
	focusIsProgrammatic = true;
	void nextTick(() => {
		const field = input.value;
		if (field !== null) {
			field.focus();
			field.setSelectionRange(caret, caret);
		}
		selection.value = { start: caret, end: caret };
		focusIsProgrammatic = false;
	});
}

/**
 * Writes the row over the span the target covers. The caret follows the
 * inserted name, so the operator can be typed without reaching for the mouse.
 */
function pick(row: SuggestionRow): void {
	const text = props.modelValue;
	const field = input.value;
	const start = field?.selectionStart ?? text.length;
	const end = field?.selectionEnd ?? start;
	const next = clausePick({
		kind: props.kind,
		value: text,
		caret: start,
		selectionEnd: end,
		insertText: row.insertText,
		identifierQuote: identifierQuote.value,
	});
	emit("update:modelValue", next.value);
	close();
	if (props.commitOnPick) emit("submit");
	refocus(next.caret);
}

/** Clearing is an edit like any other, so it commits the same way Enter does. */
function clear(): void {
	emit("update:modelValue", "");
	emit("submit");
	// Same race as `pick`: an empty field that regains focus is the "show me
	// suggestions" signal, so the flag has to cover this one too.
	refocus(0);
}

function syncSelection(): void {
	const field = input.value;
	if (field === null) return;
	selection.value = {
		start: field.selectionStart ?? 0,
		end: field.selectionEnd ?? 0,
	};
}

/** The input is fully controlled, so the value is read straight off the event. */
function onInput(event: Event): void {
	const target = event.target;
	if (!(target instanceof HTMLInputElement)) return;
	syncSelection();
	emit("update:modelValue", target.value);
	// The list follows the fragment: it opens on the keystroke that gives it
	// something to offer, and closes where there is nothing left to say — inside
	// a quoted value, or on a half-typed connector.
	open.value =
		rowsFor(target.value, target.selectionStart ?? 0, target.selectionEnd ?? 0)
			.length > 0;
}

/**
 * Moves the caret into the field. The window shell owns the Cmd/Ctrl+L chord
 * but cannot reach an input nested inside a result, so it asks the grid, which
 * asks this field — the one thing the shell cannot do for itself.
 */
function focusInput(): void {
	input.value?.focus();
	syncSelection();
}

defineExpose({ focus: focusInput });

function move(step: number): void {
	const total = rows.value.length;
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
		case "Tab": {
			const row = open.value ? rows.value[activeIndex.value] : undefined;
			if (row === undefined) return;
			event.preventDefault();
			pick(row);
			return;
		}
		case "Enter": {
			event.preventDefault();
			const row = open.value ? rows.value[activeIndex.value] : undefined;
			if (row !== undefined && !row.connector) pick(row);
			else emit("submit");
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
	syncSelection();
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
watch(rows, (next) => {
	if (activeIndex.value >= next.length) activeIndex.value = 0;
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
			:class="frame"
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
				:aria-invalid="invalid || undefined"
				class="h-[1.375rem] min-w-0 flex-1 bg-transparent px-0 text-[0.825rem] outline-none placeholder:text-muted-foreground"
				:placeholder="placeholder"
				@input="onInput"
				@keydown="onKeydown"
				@keyup="syncSelection"
				@click="syncSelection"
				@select="syncSelection"
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
			v-if="open && rows.length > 0"
			ref="list"
			role="listbox"
			:aria-label="`${label} suggestions`"
			class="bg-popover text-popover-foreground absolute left-0 top-full z-50 mt-1 max-h-56 min-w-full overflow-y-auto rounded-md border p-1 shadow-md"
		>
			<!-- `mousedown.prevent` keeps focus on the input. WebKit does not focus
			     a button on click, so without it the press blurs the input,
			     `onFocusOut` closes the list, and the row is gone before its click
			     ever fires. Chromium focuses the button, which hid this. -->
			<button
				v-for="(row, index) in rows"
				:key="row.value"
				type="button"
				role="option"
				:aria-selected="index === activeIndex"
				class="flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-xs"
				:class="index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'"
				@mousedown.prevent
				@mouseenter="activeIndex = index"
				@click="pick(row)"
			>
				<span class="truncate">{{ row.value }}</span>
				<span
					v-if="row.detail"
					class="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground"
				>
					{{ row.detail }}
				</span>
			</button>
		</div>
	</div>
</template>
