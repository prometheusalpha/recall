<script setup lang="ts">
/**
 * The row that names what the active data tab is looking at: connection, table,
 * database, and how many columns came back. It answers "where am I?" without
 * making the user read the SQL, which sits dimmed in the status bar instead.
 */
import { computed } from "vue";
import { useConnectionsStore } from "../../stores/connections";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const props = defineProps<{
	connectionId: string;
	database: string;
	schema: string;
	/** The table being browsed; the strongest pill, since it is the subject. */
	table?: string;
	/** Column names of the loaded result. */
	columns: string[];
	/** Columns currently rendered; always a subset of `columns`. */
	visibleColumns: string[];
}>();

const emit = defineEmits<{
	"update:visibleColumns": [columns: string[]];
}>();

const connections = useConnectionsStore();

const connectionName = computed(
	() =>
		connections.configs.find((config) => config.id === props.connectionId)?.name ??
		"Connection",
);

const hiddenCount = computed(
	() => props.columns.length - props.visibleColumns.length,
);

function toggleColumn(column: string, visible: boolean): void {
	const next = new Set(props.visibleColumns);
	if (visible) next.add(column);
	else next.delete(column);
	emit("update:visibleColumns", props.columns.filter((name) => next.has(name)));
}
</script>

<template>
	<div class="result-context-row" data-slot="result-context-row">
		<span class="result-context-pill" :title="connectionName">
			{{ connectionName }}
		</span>
		<span class="result-context-pill result-context-pill--primary">
			{{ table || schema || database }}
		</span>
		<span
			v-if="(table || schema) && database !== (table || schema)"
			class="result-context-pill"
		>
			{{ database }}
		</span>
		<span class="result-context-pill">{{ columns.length }} Columns</span>

		<div class="flex-1" />

		<DropdownMenu>
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