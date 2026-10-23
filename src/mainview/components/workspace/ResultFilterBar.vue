<script setup lang="ts">
/**
 * The band directly above the grid: filter controls on the left, actions on the
 * right. DBX keeps both on one row, so this does too.
 *
 * WHERE and ORDER BY are passed straight through as raw SQL fragments. The grid
 * re-runs the statement with them appended, which is what makes them a server
 * filter rather than a client-side one over an already-truncated result.
 *
 * A filter is applied on Enter or on the clear button, never while typing, so
 * a half-typed clause never reaches the server mid-word.
 */
import { computed, ref, watch } from "vue";
import { ArrowUpDown, Check, Filter, GripVertical, Minus, TriangleAlert, X } from "lucide-vue-next";
import type { BackendError, SqlDbType } from "../../../shared/types";
import { Button } from "../ui/button";
import ClauseSuggestInput from "./ClauseSuggestInput.vue";
import { useListReorder } from "../../composables/useListReorder";
import { moveItem } from "../../lib/columnOrder";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const props = withDefaults(
	defineProps<{
		/** Raw `WHERE` expression, without the keyword. Empty means no filter. */
		where: string;
		/** Raw `ORDER BY` expression, without the keyword. */
		orderBy: string;
		/** False for a query tab, which has no statement to rebuild. */
		sortable: boolean;
		busy?: boolean;
		/** Every column the statement returned. */
		columns?: string[];
		/** Declared SQL type per column, parallel to `columns`. */
		columnTypes?: string[];
		/** Connection dialect, so a suggested column is inserted quoted only if needed. */
		dbType?: SqlDbType;
		/** The subset currently rendered; always a subset of `columns`. */
		visibleColumns?: string[];
		/**
		 * `columns` in the grid's display order, hidden ones included. The menu
		 * lists this so dragging a row and dragging a header move one order.
		 */
		orderedColumns?: string[];
		/**
		 * The clause failure of the last run, while the rows on screen are the
		 * ones from before it. The band is where the fix goes, so it stays and
		 * reports the failure itself instead of the pane going blank.
		 */
		error?: BackendError | null;
		/**
		 * Which field the server blamed, when the failure can be pinned to one.
		 * Null marks neither, and only the card names the message.
		 */
		errorTarget?: "where" | "orderBy" | null;
	}>(),
	{
		columns: () => [],
		visibleColumns: () => [],
		orderedColumns: () => [],
		columnTypes: () => [],
		error: null,
		errorTarget: null,
	},
);

const emit = defineEmits<{
	"update:where": [value: string];
	"update:orderBy": [value: string];
	/** Fired on Enter, or when the clear button is pressed. */
	apply: [];
	"update:visibleColumns": [columns: string[]];
	"update:orderedColumns": [columns: string[]];
}>();

/** The shape `ClauseSuggestInput` exposes via `defineExpose`. */
interface ClauseInputHandle {
	focus: () => void;
}

/**
 * The WHERE segment, held so the window shell's Cmd/Ctrl+L can move focus into
 * it. Typed as `object` like `AppSidebar`'s tree handle, so this file compiles
 * whether or not the SFC's own types are visible, and recovered by the cast in
 * `focusWhere`.
 */
const whereInput = ref<object | null>(null);

/**
 * Published to the grid, which forwards it to the shell. `false` means this
 * band has no WHERE box (a query tab, where `sortable` is false), so the shell
 * can leave the chord to the webview instead of swallowing it on a dead end.
 */
function focusWhere(): boolean {
	const field = whereInput.value as ClauseInputHandle | null;
	if (field === null) return false;
	field.focus();
	return true;
}

defineExpose({ focusWhere });

/** Falls back to the statement's order for a parent that does not reorder. */
const menuColumns = computed(() =>
	props.orderedColumns.length > 0 ? props.orderedColumns : props.columns,
);

const columnDrag = useListReorder({
	rowSelector: "[data-column-row]",
	listSelector: "[data-column-menu]",
	onReorder: (from, to) =>
		emit("update:orderedColumns", moveItem(menuColumns.value, from, to)),
});

const hiddenCount = computed(
	() => props.columns.length - props.visibleColumns.length,
);

/**
 * The all-row has three states, and `reka` reads the middle one off the same
 * `modelValue` prop as a string, which is why the template passes
 * `"indeterminate"` rather than a second prop.
 */
const allVisible = computed(() => hiddenCount.value === 0);
const someHidden = computed(
	() => hiddenCount.value > 0 && hiddenCount.value < props.columns.length,
);

/** The all-row writes the whole list at once, still in the statement's order. */
function setAllColumns(visible: boolean): void {
	emit("update:visibleColumns", visible ? [...props.columns] : []);
}

/**
 * Toggling never reorders: the emit is rebuilt from `columns`, so the grid keeps
 * the statement's column order regardless of the click sequence.
 */
function toggleColumn(column: string, visible: boolean): void {
	const next = new Set(props.visibleColumns);
	if (visible) next.add(column);
	else next.delete(column);
	emit(
		"update:visibleColumns",
		props.columns.filter((name) => next.has(name)),
	);
}

/**
 * The card starts open and stays until it is dismissed or the clause loads:
 * a failure the user cannot see is the failure they will hit again. A new
 * failure reopens it, so dismissing one run's message does not silence the
 * next one's.
 */
const errorDismissed = ref(false);
watch(
	() => props.error,
	() => {
		errorDismissed.value = false;
	},
);

/** The two expressions are edited in local state and pushed up on Enter or on
 * clear, never per keystroke.
 *
 * Binding them straight to the parent meant every keystroke crossed three
 * component boundaries and re-rendered the whole virtualised grid behind the
 * filter row, which is what made typing stutter. Worse, the value was passed
 * as `value` while the input declared `modelValue`, so the text was wiped on
 * every re-render and appeared to refuse input at all.
 */
const whereDraft = ref(props.where);
const orderByDraft = ref(props.orderBy);

/**
 * Identifies a pair of expressions. A NUL cannot occur in either half, so the
 * two can never be mistaken for one another.
 */
function signature(where: string, orderBy: string): string {
	return `${where}\u0000${orderBy}`;
}

/**
 * What the parent already knows about. Re-seeding the drafts from props must
 * not count as an edit, so this is compared before another query is issued.
 */
let lastApplied = signature(props.where, props.orderBy);

/** Re-seed when the tab changes underneath, but never mid-edit. */
watch(
	() => [props.where, props.orderBy] as const,
	([where, orderBy]) => {
		whereDraft.value = where;
		orderByDraft.value = orderBy;
		lastApplied = signature(where, orderBy);
	},
);

/**
 * Pushes the edit up and re-runs. A no-op when the expression is unchanged, so
 * typing and then undoing the characters does not fire a pointless query.
 */
function commit(): void {
	const next = signature(whereDraft.value, orderByDraft.value);
	if (next === lastApplied) return;
	lastApplied = next;
	emit("update:where", whereDraft.value);
	emit("update:orderBy", orderByDraft.value);
	emit("apply");
}
</script>

<template>
	<div class="result-filterbar relative" data-slot="result-filterbar">
		<!-- The failure card, anchored under the band rather than in place of
		     the grid. The clause that caused it is a few pixels away, and the
		     rows behind this are the last ones that loaded, so the pane keeps
		     both while the message says why they are old. -->
		<div
			v-if="error && !errorDismissed"
			role="alert"
			class="bg-popover text-popover-foreground absolute inset-x-0 top-full z-40 mx-0.5 mt-1 flex items-start gap-2 rounded-md border border-destructive/40 px-2 py-1.5 shadow-md"
		>
			<TriangleAlert
				class="mt-0.5 size-3.5 shrink-0 text-destructive"
				aria-hidden="true"
			/>
			<div class="min-w-0 flex-1">
				<p class="break-words font-mono text-[11px] text-destructive">
					{{ error.message }}
				</p>
				<p
					v-if="error.detail"
					class="mt-0.5 break-words whitespace-pre-wrap text-[11px] text-muted-foreground"
				>
					{{ error.detail }}
				</p>
				<p class="mt-0.5 text-[11px] text-muted-foreground">
					<code class="rounded border border-border px-1 font-mono">{{ error.code }}</code>
					· rows below are the last result that loaded
				</p>
			</div>
			<button
				type="button"
				class="grid size-[1.1rem] shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
				aria-label="Dismiss error"
				@click="errorDismissed = true"
			>
				<X class="size-[0.825rem]" aria-hidden="true" />
			</button>
		</div>

		<!-- Hidden entirely for a query tab: there is no generated statement to
		     append a WHERE to, so an enabled box here would be a dead end. -->
		<template v-if="sortable">
			<!-- One frame, two segments. The divider is the only mark between
			     them, so the pair reads as a single control instead of two
			     boxes. No `overflow-hidden`: it would clip the suggestion
			     popup, which is anchored inside a segment. -->
			<div
				class="flex min-w-0 flex-1 items-stretch self-stretch border-x bg-background"
			>
				<ClauseSuggestInput
					ref="whereInput"
					v-model="whereDraft"
					kind="where"
					label="WHERE"
					:icon="Filter"
					accent="text-info"
					placeholder=""
					:columns="columns"
					:column-types="columnTypes"
					:db-type="dbType"
					:invalid="errorTarget === 'where'"
					:style="{ flexGrow: 1.4 }"
					@submit="commit"
				/>

				<ClauseSuggestInput
					v-model="orderByDraft"
					kind="orderBy"
					label="ORDER BY"
					:icon="ArrowUpDown"
					accent="text-warning"
					placeholder=""
					:columns="columns"
					:column-types="columnTypes"
					:db-type="dbType"
					:invalid="errorTarget === 'orderBy'"
					class="border-l"
					@submit="commit"
				/>
			</div>
		</template>

		<!-- Grid-owned actions next to Columns, e.g. committing staged edits. -->
		<slot name="actions" />

		<!-- Column visibility lives with the other actions rather than in its own
		     row: it is per-result state, and a second band above the grid is
		     height the data does not get back. -->
		<DropdownMenu v-if="columns.length > 0">
			<DropdownMenuTrigger as-child>
				<Button size="micro" variant="ghost">
					Columns
					<span
						v-if="hiddenCount > 0"
						class="tabular-nums text-muted-foreground"
					>
						{{ visibleColumns.length }}/{{ columns.length }}
					</span>
				</Button>
			</DropdownMenuTrigger>
			<!-- Wide enough for the column names rather than the trigger: the
			     shared content width is the trigger's, which cut long names off
			     at the button's few characters. `w-max` grows to the longest
			     name, capped by the space the popper reports. -->
			<DropdownMenuContent
				data-column-menu
				align="end"
				class="max-h-80 w-max min-w-56 max-w-[min(32rem,var(--reka-dropdown-menu-content-available-width))] overflow-y-auto"
			>
				<DropdownMenuLabel>Columns</DropdownMenuLabel>
				<!-- The menu stays open across a tick (`@select.prevent`), so
				     hiding five columns is five clicks and not five reopens.
				     `reka` closes on select by default, and a list that closes
				     under the pointer is what a checkbox list must not do. -->
				<DropdownMenuCheckboxItem
					:model-value="allVisible ? true : someHidden ? 'indeterminate' : false"
					class="pr-1.5"
					@select.prevent
					@update:model-value="setAllColumns"
				>
					<!-- Empty, not absent: `reka` appends its own tick on the right,
					     and the tick this row draws on the left is the only one. -->
					<template #indicator-icon><span /></template>
					<span
						class="flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border"
						:class="allVisible ? 'border-primary bg-primary' : 'border-input'"
					>
						<!-- `stroke`, not `text`: the item paints every descendant
						     `accent-foreground` on focus, and that is the same
						     near-black as the filled box in the light theme. -->
						<Check
							v-if="allVisible"
							class="size-2.5 stroke-primary-foreground"
							aria-hidden="true"
						/>
						<!-- The dash sits in an *unfilled* box, so it takes the box's
						     own colour rather than the filled box's tick colour. -->
						<Minus
							v-else-if="someHidden"
							class="size-2.5 stroke-foreground"
							aria-hidden="true"
						/>
					</span>
					<span class="truncate">All columns</span>
				</DropdownMenuCheckboxItem>
				<DropdownMenuSeparator />
				<!-- The drop rule is drawn on the row the drop displaces, on the
				     edge the dragged row will land against. -->
				<DropdownMenuCheckboxItem
					v-for="(column, index) in menuColumns"
					:key="column"
					data-column-row
					:model-value="visibleColumns.includes(column)"
					class="relative pr-1.5 pl-0.5"
					:class="[
						columnDrag.dragging.value === index && 'opacity-50',
						columnDrag.dropMarker.value?.index === index &&
							(columnDrag.dropMarker.value.edge === 'top'
								? 'before:absolute before:inset-x-1 before:top-0 before:h-0.5 before:bg-primary'
								: 'before:absolute before:inset-x-1 before:bottom-0 before:h-0.5 before:bg-primary'),
					]"
					@select.prevent
					@update:model-value="toggleColumn(column, $event)"
				>
					<!-- Empty, not absent: `reka` appends its own tick on the right,
					     and the tick this row draws on the left is the only one. -->
					<template #indicator-icon><span /></template>
					<!-- The handle alone starts a drag, so a click anywhere else on
					     the row still toggles it. `click.stop` keeps a press that
					     never became a drag from toggling the row either. -->
					<span
						class="-mr-1 flex shrink-0 cursor-grab touch-none items-center text-muted-foreground hover:text-foreground"
						aria-hidden="true"
						@pointerdown="columnDrag.start($event, index)"
						@click.stop.prevent
					>
						<GripVertical class="size-3.5" />
					</span>
					<span
						class="flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border"
						:class="
							visibleColumns.includes(column)
								? 'border-primary bg-primary'
								: 'border-input'
						"
					>
						<Check
							v-if="visibleColumns.includes(column)"
							class="size-2.5 stroke-primary-foreground"
							aria-hidden="true"
						/>
					</span>
					<!-- Past the cap the name is ellipsised, so the full name
					     stays one hover away. -->
					<span class="truncate" :title="column">{{ column }}</span>
				</DropdownMenuCheckboxItem>
			</DropdownMenuContent>
		</DropdownMenu>
	</div>
</template>