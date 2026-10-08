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
import { ArrowUpDown, Filter } from "lucide-vue-next";
import { Button } from "../ui/button";
import ClauseSuggestInput from "./ClauseSuggestInput.vue";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
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
		/** The subset currently rendered; always a subset of `columns`. */
		visibleColumns?: string[];
	}>(),
	{
		columns: () => [],
		visibleColumns: () => [],
		columnTypes: () => [],
	},
);

const emit = defineEmits<{
	"update:where": [value: string];
	"update:orderBy": [value: string];
	/** Fired on Enter, or when the clear button is pressed. */
	apply: [];
	"update:visibleColumns": [columns: string[]];
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

const hiddenCount = computed(
	() => props.columns.length - props.visibleColumns.length,
);

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
 * The two expressions are edited in local state and pushed up on Enter or on
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
	<div class="result-filterbar" data-slot="result-filterbar">

		<!-- Hidden entirely for a query tab: there is no generated statement to
		     append a WHERE to, so an enabled box here would be a dead end. -->
		<template v-if="sortable">
			<!-- One frame, two segments. The divider is the only mark between
			     them, so the pair reads as a single control instead of two
			     boxes. No `overflow-hidden`: it would clip the suggestion
			     popup, which is anchored inside a segment. -->
			<div
				class="flex min-w-0 max-w-[72rem] flex-1 items-stretch self-stretch border-x bg-background"
			>
				<ClauseSuggestInput
					ref="whereInput"
					v-model="whereDraft"
					label="WHERE"
					:icon="Filter"
					accent="text-info"
					placeholder="name = 'Alice'"
					:columns="columns"
					:column-types="columnTypes"
					@submit="commit"
				/>

				<ClauseSuggestInput
					v-model="orderByDraft"
					label="ORDER BY"
					:icon="ArrowUpDown"
					accent="text-warning"
					placeholder="name ASC"
					:columns="columns"
					:column-types="columnTypes"
					class="border-l"
					@submit="commit"
				/>
			</div>
		</template>

		<div class="flex-1" />

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
			<DropdownMenuContent align="end" class="max-h-80 overflow-y-auto">
				<DropdownMenuLabel>Columns</DropdownMenuLabel>
				<DropdownMenuCheckboxItem
					v-for="column in columns"
					:key="column"
					:model-value="visibleColumns.includes(column)"
					@update:model-value="toggleColumn(column, $event)"
				>
					{{ column }}
				</DropdownMenuCheckboxItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					:disabled="hiddenCount === 0"
					@select="emit('update:visibleColumns', [...columns])"
				>
					Show all
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	</div>
</template>