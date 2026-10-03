<script setup lang="ts">
/**
 * The band directly above the grid: filter controls on the left, actions on the
 * right. DBX keeps both on one 32px row, so this does too.
 *
 * WHERE and ORDER BY are passed straight through as raw SQL fragments. The grid
 * re-runs the statement with them appended, which is what makes them a server
 * filter rather than a client-side one over an already-truncated result.
 *
 * A filter is applied on Enter or on the clear button, never while typing, so
 * a half-typed clause never reaches the server mid-word.
 */
import { computed, ref, watch } from "vue";
import { Filter, RefreshCw, X } from "lucide-vue-next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const props = defineProps<{
	/** Raw `WHERE` expression, without the keyword. Empty means no filter. */
	where: string;
	/** Raw `ORDER BY` expression, without the keyword. */
	orderBy: string;
	/** False for a query tab, which has no statement to rebuild. */
	sortable: boolean;
	busy?: boolean;
}>();

const emit = defineEmits<{
	"update:where": [value: string];
	"update:orderBy": [value: string];
	/** Fired on Enter, or when the clear button is pressed. */
	apply: [];
	rerun: [];
}>();

/**
 * The two expressions are edited in local state and pushed up on Enter or on
 * clear, never per keystroke.
 *
 * Binding them straight to the parent meant every keystroke crossed three
 * component boundaries and re-rendered the whole virtualised grid behind the
 * filter row, which is what made typing stutter. Worse, the value was passed
 * as `value` while `Input` declares `modelValue`, so the text was wiped on
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

const whereActive = computed(() => whereDraft.value.trim().length > 0);
const orderByActive = computed(() => orderByDraft.value.trim().length > 0);

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

function clearWhere(): void {
	whereDraft.value = "";
	commit();
}

function clearOrderBy(): void {
	orderByDraft.value = "";
	commit();
}

</script>

<template>
	<div class="result-filterbar" data-slot="result-filterbar">
		<DropdownMenu>
			<DropdownMenuTrigger as-child>
				<Button size="micro" variant="ghost">
					All rows
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuItem disabled>All rows</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>

		<!-- Hidden entirely for a query tab: there is no generated statement to
		     append a WHERE to, so an enabled box here would be a dead end. -->
		<template v-if="sortable">
			<Filter
				class="size-3 shrink-0"
				:class="whereActive ? 'text-info' : 'text-muted-foreground'"
				aria-hidden="true"
			/>
			<span
				class="result-filterbar-label"
				:class="whereActive ? 'text-info' : 'text-muted-foreground'"
			>
				WHERE
			</span>
			<Input
				v-model="whereDraft"
				spellcheck="false"
				autocomplete="off"
				autocorrect="off"
				autocapitalize="off"
				class="h-6 min-w-0 flex-1 text-xs"
				placeholder="name = 'Alice'"
				aria-label="Filter expression"
				@keydown.enter.prevent="commit"
			/>
			<Button
				v-if="whereActive"
				size="icon-xs"
				variant="ghost"
				class="size-5 shrink-0"
				aria-label="Clear filter"
				@click="clearWhere"
			>
				<X aria-hidden="true" />
			</Button>

			<span
				class="result-filterbar-label"
				:class="orderByActive ? 'text-warning' : 'text-muted-foreground'"
			>
				ORDER BY
			</span>
			<Input
				v-model="orderByDraft"
				spellcheck="false"
				autocomplete="off"
				autocorrect="off"
				autocapitalize="off"
				class="h-6 min-w-0 flex-1 text-xs"
				placeholder="name ASC"
				aria-label="Sort expression"
				@keydown.enter.prevent="commit"
			/>
			<Button
				v-if="orderByActive"
				size="icon-xs"
				variant="ghost"
				class="size-5 shrink-0"
				aria-label="Clear sort"
				@click="clearOrderBy"
			>
				<X aria-hidden="true" />
			</Button>
		</template>

		<div class="flex-1" />

		<Button
			size="micro"
			variant="ghost"
			:disabled="busy"
			@click="emit('rerun')"
		>
			<RefreshCw class="size-3" aria-hidden="true" />
			Refresh
		</Button>
	</div>
</template>