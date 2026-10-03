<script setup lang="ts">
/**
 * Virtualised result grid with rectangular cell selection and inline editing.
 *
 * Hand-rolled on `vue-virtual-scroller` — no grid library. The header row and
 * the body share one horizontal scroll container, and because every cell has an
 * explicit pixel width the columns stay aligned while scrolling.
 *
 * Selection is addressed by absolute result indices, never by what the scroller
 * happens to have in the DOM: a range can reach far past the rendered rows, and
 * both copy and edit have to work on values that were never painted.
 *
 * A failed statement is data, not an exception: the query store writes a
 * one-column `Error` result, and `result.error` is set, so the failure renders
 * as a centred panel in the same place the rows would have been.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { CSSProperties } from "vue";
import { ArrowDown, ArrowUp, Download, TriangleAlertIcon } from "lucide-vue-next";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import type { StatementResult } from "../../../shared/types";
import { toast } from "../../composables/useToast";
import { errorMessage, rpc } from "../../lib/rpc";
import {
	useGridSelection,
	type GridNavigationDirection,
} from "../../composables/useGridSelection";
import { Button } from "../ui/button";
import ResultFilterBar from "./ResultFilterBar.vue";

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const ROW_NUMBER_WIDTH = 56;
const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 120;

const props = withDefaults(
	defineProps<{
		/** One statement's outcome. */
		result: StatementResult;
		/** Column width in px; never drops below 120px. */
		columnWidth?: number;
		/**
		 * The table this result came from. Present only for a table tab, and it
		 * is what makes the cells editable and the header sortable: a query
		 * result has no table behind it to re-sort or UPDATE.
		 */
		editable?: {
			connectionId: string;
			database: string;
			schema: string;
			table: string;
			/** Primary key columns, needed to address a row for UPDATE. */
			keyColumns: string[];
		} | null;
		busy?: boolean;
		/** Raw WHERE expression shown in the filter band. */
		where?: string;
		/** Raw ORDER BY expression shown in the filter band. */
		orderBy?: string;
		/**
		 * False when there is no generated statement to append a WHERE to — a
		 * query tab, whose SQL the user wrote and must not have rewritten.
		 */
		filterable?: boolean;
		/** Column names to omit, for the popover that lives in the context row. */
		hiddenColumns?: Set<string>;
	}>(),
	{
		columnWidth: DEFAULT_COLUMN_WIDTH,
		editable: null,
		busy: false,
		where: "",
		orderBy: "",
		filterable: false,
		hiddenColumns: () => new Set<string>(),
	},
);

const emit = defineEmits<{
	/** Re-run the statement that produced this result. */
	rerun: [];
	/** The table tab's sort, so the caller can rebuild its SELECT. */
	sort: [column: string, direction: "asc" | "desc"];
	/** The toolbar asked for an export; the caller owns the folder picker. */
	export: [format: "csv" | "json"];
	"update:where": [value: string];
	"update:orderBy": [value: string];
	/** Enter in either filter field: re-run the statement with the new filter. */
	applyFilter: [];
}>();

const error = computed(() => props.result.error);
const rows = computed(() => props.result.rows);

/**
 * Columns the user has hidden. Owned by the workspace so the popover in the
 * context row and the columns rendered here can never disagree.
 */
const hiddenColumns = computed(() => props.hiddenColumns);
const columns = computed(() =>
	props.result.columns.filter((name) => !hiddenColumns.value.has(name)),
);
/** Result index of each rendered column, so selection survives hiding columns. */
const columnIndexes = computed(() =>
	columns.value.map((name) => props.result.columns.indexOf(name)),
);

const editable = computed(() => props.editable);

/** Editing needs somewhere to send an UPDATE, so a keyless table is read-only. */
const canEdit = computed(
	() => editable.value !== null && editable.value.keyColumns.length > 0,
);

/**
 * Rows per screen, used by PageUp/PageDown. Derived from the scroller's own
 * height so it stays right when the split pane is dragged.
 */
const pageRows = ref(20);
const scrollerEl = ref<HTMLElement | null>(null);

/**
 * Explicit width per column, keyed by name. Absent means the shared default.
 * Keying by name rather than index is what lets a width survive hiding a
 * different column and re-running the statement.
 */
const columnWidths = ref<Record<string, number>>({});

const columnPixelWidth = computed(() =>
	Math.max(MIN_COLUMN_WIDTH, props.columnWidth),
);

/** Width of one rendered column, honouring any per-column override. */
function widthFor(column: string): number {
	return Math.max(MIN_COLUMN_WIDTH, columnWidths.value[column] ?? columnPixelWidth.value);
}

function totalWidthFor(list: string[]): number {
	return ROW_NUMBER_WIDTH + list.reduce((sum, column) => sum + widthFor(column), 0);
}

const totalWidth = computed(() => totalWidthFor(columns.value));

/** Widths for the header and the body, so the two stay aligned by construction. */
function cellStyleFor(column: string): CSSProperties {
	const width = widthFor(column);
	return { width: `${width}px`, minWidth: `${width}px` };
}

const selection = useGridSelection({
	rowCount: () => rows.value.length,
	columnCount: () => columns.value.length,
	pageSize: () => pageRows.value,
});

/** The grid owns focus while the user is navigating cells, so arrows move the
 *  cursor instead of scrolling the page. */
const gridFocused = ref(false);

/** Sort indicator: the column the caller last sorted by, and how. */
const sortColumn = ref<string | null>(null);
const sortDirection = ref<"asc" | "desc">("asc");

function cycleSort(column: string): void {
	if (sortColumn.value !== column) {
		sortColumn.value = column;
		sortDirection.value = "asc";
	} else if (sortDirection.value === "asc") {
		sortDirection.value = "desc";
	} else {
		// A third click drops the ORDER BY entirely and restores the natural
		// order, which is the only way back to the server's default.
		sortColumn.value = null;
	}
	if (sortColumn.value) emit("sort", sortColumn.value, sortDirection.value);
	else emit("sort", "", "asc");
}

/** Pointer state for the resize handle on one column's right edge. */
const resizing = ref<{ column: string; startX: number; startWidth: number } | null>(null);

/**
 * A resize has to keep tracking the pointer after it leaves the handle, so the
 * move and release handlers live on the window rather than on the handle.
 */
function startColumnResize(event: PointerEvent, column: string): void {
	event.preventDefault();
	event.stopPropagation();
	if (resizing.value) return;
	resizing.value = {
		column,
		startX: event.clientX,
		startWidth: widthFor(column),
	};
	window.addEventListener("pointermove", onColumnResizeMove);
	window.addEventListener("pointerup", stopColumnResize, { once: true });
}

function onColumnResizeMove(event: PointerEvent): void {
	const state = resizing.value;
	if (!state) return;
	columnWidths.value = {
		...columnWidths.value,
		[state.column]: Math.max(MIN_COLUMN_WIDTH, state.startWidth + event.clientX - state.startX),
	};
}

function stopColumnResize(): void {
	resizing.value = null;
	window.removeEventListener("pointermove", onColumnResizeMove);
	window.removeEventListener("pointerup", stopColumnResize);
}

/** Double-click restores the shared default, which is how every tool does it. */
function resetColumnWidth(column: string): void {
	if (columnWidths.value[column] === undefined) return;
	const next = { ...columnWidths.value };
	delete next[column];
	columnWidths.value = next;
}

function sortIcon(column: string): "asc" | "desc" | null {
	if (sortColumn.value !== column) return null;
	return sortDirection.value;
}

/** The cell being edited, or null. Editing is deliberately not in the store. */
const editing = ref<{ row: number; col: number; draft: string } | null>(null);
const editorEl = ref<HTMLInputElement | null>(null);

/**
 * The text a visible column shows for a row.
 *
 * `col` is a *visible* column index, so it has to be translated through
 * `columnIndexes` first. Reading the row with it directly would hand the editor
 * and the clipboard the value of whichever result column happens to sit at that
 * position — invisible after a column is hidden, and it would silently write the
 * wrong value to the wrong column.
 */
function cellText(row: number, col: number): string {
	const resultCol = columnIndexes.value[col];
	if (resultCol === undefined) return "";
	return formatValue(cellAt(rows.value[row], resultCol));
}

function startEdit(row: number, col: number): void {
	if (!canEdit.value) return;
	// Tab past the last column would otherwise open an editor on no cell at all.
	if (col >= columns.value.length || row >= rows.value.length) return;
	editing.value = { row, col, draft: cellText(row, col) };
	void nextTick(() => {
		editorEl.value?.focus();
		editorEl.value?.select();
	});
}

function cancelEdit(): void {
	editing.value = null;
}

/**
 * Turns the editor's text back into the value type the driver should bind.
 * An empty string becomes NULL rather than an empty string, because an empty
 * string is never what someone means by clearing a cell.
 */
function parseDraft(draft: string): unknown {
	if (draft === "") return null;
	const asNumber = Number(draft);
	if (draft.trim() !== "" && !Number.isNaN(asNumber)) return asNumber;
	return draft;
}

async function commitEdit(move?: { row: number; col: number }): Promise<void> {
	const pending = editing.value;
	if (!pending) return;
	const target = editable.value;
	if (!target) {
		editing.value = null;
		return;
	}
	// `pending.col` indexes the columns the grid is *showing*. Once a column has
	// been hidden that no longer lines up with the result, so the visible index
	// is translated before it is used to name the column to write.
	const resultCol = columnIndexes.value[pending.col];
	const column =
		resultCol === undefined ? undefined : props.result.columns[resultCol];
	if (column === undefined) {
		editing.value = null;
		return;
	}
	const keyValues = target.keyColumns.map((name) => {
		const keyIndex = props.result.columns.indexOf(name);
		return keyIndex === -1 ? null : cellAt(rows.value[pending.row], keyIndex);
	});

	editing.value = null;
	try {
		await rpc.request.updateCell(
			{
				connectionId: target.connectionId,
				database: target.database,
				schema: target.schema,
				table: target.table,
				keyColumns: target.keyColumns,
				keyValues,
				column,
				value: parseDraft(pending.draft),
			},
			{ maxRequestTime: 30_000 },
		);
		toast(`Updated ${target.table}.${column}`);
		// Re-read the row rather than trusting the value we sent: a trigger or
		// a generated column can store something other than what was written.
		emit("rerun");
	} catch (err) {
		toast(errorMessage(err));
	}
	if (move) startEdit(move.row, move.col);
}

/** True when the cell at a rendered column currently shows NULL. */
function isNullAt(row: number, col: number): boolean {
	return isNullValue(cellAt(rows.value[row], col));
}

/** The header/row-number chrome for a whole column or row selection. */
function columnIsSelected(col: number): boolean {
	return selection.isSelected(0, col);
}

function rowIsSelected(row: number): boolean {
	const last = columns.value.length - 1;
	return columns.value.length > 0 && selection.isSelected(row, last);
}

/**
 * Click handling. A shift-click extends from the existing anchor, a plain click
 * collapses the selection onto one cell, and the row-number gutter selects the
 * whole row as a range rather than introducing a second selection model.
 */
function onCellClick(row: number, col: number, event: MouseEvent): void {
	if (event.shiftKey) selection.extendSelectionTo({ row, col });
	else selection.selectCell({ row, col });
}

/**
 * Drag state. Pressing a cell anchors the selection there and keeps extending it
 * as the pointer crosses other cells, which is the rectangle a spreadsheet
 * makes — rather than the browser's own text selection.
 */
const dragging = ref(false);

function onCellPointerDown(row: number, col: number, event: PointerEvent): void {
	if (event.button !== 0 || dragging.value) return;
	dragging.value = true;
	selection.selectCell({ row, col });
	// The grid owns its own selection, so the browser's text selection — which
	// would highlight the cell *text* rather than the cells — has to be off for
	// the whole document, not just for the element the pointer went down on.
	document.addEventListener("selectionchange", blockNativeSelection);
	window.addEventListener("pointerup", endCellDrag, { once: true });
	window.addEventListener("pointermove", onCellDragMove);
	window.addEventListener("pointercancel", endCellDrag, { once: true });
}

function onCellDragMove(event: PointerEvent): void {
	if (!dragging.value) return;
	const target = document.elementFromPoint(event.clientX, event.clientY);
	const cell = target?.closest<HTMLElement>(".grid-cell[data-row]");
	if (!cell) return;
	const row = Number(cell.dataset.row);
	const col = Number(cell.dataset.col);
	if (Number.isFinite(row) && Number.isFinite(col)) {
		selection.extendSelectionTo({ row, col });
	}
}

function endCellDrag(): void {
	stopCellDrag();
}

/**
 * Drops every listener a pointer gesture can leave behind. A drag only ever
 * ends on a `pointerup` that reaches the window, so a press released off the
 * window — or a grid that unmounts mid-drag — would otherwise keep the
 * document-level suppression alive and clear the selection of whatever text
 * field the user focuses next.
 */
function stopCellDrag(): void {
	dragging.value = false;
	document.removeEventListener("selectionchange", blockNativeSelection);
	window.removeEventListener("pointerup", endCellDrag);
	window.removeEventListener("pointermove", onCellDragMove);
	window.removeEventListener("pointercancel", endCellDrag);
}

/** True when a selection boundary sits in a text field, where the browser owns
 *  the caret and its selection is not the grid's business. An `<input>` has no
 *  child text nodes, so browsers report either the element itself or its
 *  parent as the boundary. */
function insideTextField(node: Node | null): boolean {
	const element = node instanceof Element ? node : (node?.parentElement ?? null);
	return element !== null && element.closest("input, textarea") !== null;
}

/** Collapses a native selection the drag made over grid text, and nothing else.
 *  Clearing a selection inside an input is what breaks select-all and paste. */
function blockNativeSelection(): void {
	if (!dragging.value) return;
	const active = document.getSelection();
	if (!active || active.isCollapsed) return;
	if (insideTextField(active.anchorNode) || insideTextField(active.focusNode)) return;
	active.removeAllRanges();
}

onBeforeUnmount(() => {
	stopCellDrag();
	stopColumnResize();
});

function onRowNumberClick(row: number, event: MouseEvent): void {
	const last = columns.value.length - 1;
	if (last < 0) return;
	if (event.shiftKey && selection.focus.value) {
		selection.anchor.value = { row, col: 0 };
		selection.extendSelectionTo({ row: selection.focus.value.row, col: last });
		return;
	}
	selection.selectCell({ row, col: 0 });
	selection.extendSelectionTo({ row, col: last });
}

/**
 * A header click does two things, in this order: it selects the column, and —
 * only for a table tab, where the statement can be rebuilt with an ORDER BY —
 * it cycles the server-side sort. A query result has no table behind it, so
 * there is nothing to re-run and the click stays a pure selection.
 */
function onHeaderClick(col: number, event: MouseEvent): void {
	const last = rows.value.length - 1;
	if (last < 0) return;
	if (editable.value) cycleSort(columns.value[col]);
	if (event.shiftKey && selection.focus.value) {
		selection.anchor.value = { row: 0, col };
		selection.extendSelectionTo({ row: last, col: selection.focus.value.col });
		return;
	}
	selection.selectCell({ row: 0, col });
	selection.extendSelectionTo({ row: last, col });
}

const NAVIGATION_KEYS: Record<string, GridNavigationDirection> = {
	ArrowUp: "up",
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
	Home: "home",
	End: "end",
	PageUp: "pageUp",
	PageDown: "pageDown",
};

/**
 * TSV of the selected rectangle, read from the result rather than the DOM so a
 * selection larger than the viewport still copies every row.
 */
function selectionToTsv(): string {
	const r = selection.range.value;
	if (!r) return "";
	const lines: string[] = [];
	for (let row = r.startRow; row <= r.endRow; row++) {
		const cells: string[] = [];
		for (let col = r.startCol; col <= r.endCol; col++) {
			// A tab or newline inside a value would break the row/column contract
			// for whatever receives the paste, so those two become spaces.
			cells.push(cellText(row, col).replace(/[\t\r\n]/g, " "));
		}
		lines.push(cells.join("\t"));
	}
	return lines.join("\n");
}

function onKeydown(event: KeyboardEvent): void {
	if (editing.value) return;

	const accel = event.metaKey || event.ctrlKey;
	if (accel && event.key.toLowerCase() === "a") {
		event.preventDefault();
		selection.selectAll();
		return;
	}
	if (accel && event.key.toLowerCase() === "c") {
		if (!selection.range.value) return;
		event.preventDefault();
		void navigator.clipboard
			.writeText(selectionToTsv())
			.catch((err: unknown) => toast(errorMessage(err)));
		return;
	}
	if (event.key === "Escape") {
		selection.clear();
		return;
	}

	let direction: GridNavigationDirection | null = null;
	if (event.key === "Home" && (event.metaKey || event.ctrlKey)) {
		direction = "docHome";
	} else if (event.key === "End" && (event.metaKey || event.ctrlKey)) {
		direction = "docEnd";
	} else {
		direction = NAVIGATION_KEYS[event.key] ?? null;
	}
	if (!direction) return;

	event.preventDefault();
	const next = selection.nextPosition(direction);
	if (!next) return;
	if (event.shiftKey) selection.extendSelectionTo(next);
	else selection.selectCell(next);
	void nextTick(() => {
		// Move the real scroll container too: the focus cell can be outside the
		// rendered window, and the caret has to be visible to be useful.
		const container = scrollerEl.value;
		if (!container) return;
		const top = next.row * ROW_HEIGHT;
		const bottom = top + ROW_HEIGHT;
		if (top < container.scrollTop) container.scrollTop = top;
		else if (bottom > container.scrollTop + container.clientHeight) {
			container.scrollTop = bottom - container.clientHeight;
		}
	});
}

/** A fresh result invalidates every grid-local affordance tied to the old rows. */
watch(
	() => props.result,
	() => {
		selection.clear();
		editing.value = null;
	},
);

const rowNumberStyle = computed<CSSProperties>(() => ({
	width: `${ROW_NUMBER_WIDTH}px`,
	minWidth: `${ROW_NUMBER_WIDTH}px`,
}));
const rowStyle = computed<CSSProperties>(() => ({
	height: `${ROW_HEIGHT}px`,
	width: `${totalWidth.value}px`,
}));
const gridStyle = computed<CSSProperties>(() => ({ width: `${totalWidth.value}px` }));

function isNullValue(value: unknown): boolean {
	return value === null || value === undefined;
}

/** JSON-safe driver values, normalised to the text the cell shows. */
function formatValue(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return value.toString();
	}
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** Full value for hover; CSS truncation hides the tail, `title` keeps it. */
function cellTitle(value: unknown): string | undefined {
	if (isNullValue(value)) return "NULL";
	const text = formatValue(value);
	return text.length > 0 ? text : undefined;
}

/** The statement collapsed to one line, which is all the status bar can show. */
const oneLinerSql = computed(() => props.result.sql.replace(/\s+/g, " ").trim());

/** Clicking the SQL copies it, so the band is a shortcut rather than decoration. */
function copySql(): void {
	void navigator.clipboard
		.writeText(props.result.sql)
		.catch((err: unknown) => toast(errorMessage(err)));
}

function formatMs(ms: number): string {
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
	return `${ms.toFixed(ms >= 10 ? 0 : 1)} ms`;
}
/** Row values arrive as `unknown`; index access is guarded at runtime. */
function cellAt(row: unknown, index: number): unknown {
	return Array.isArray(row) ? row[index] : undefined;
}
/** Row identity for the scroller: a row is a positional array, so its index is the only stable key. Without this the scroller falls back to `key-field="id"`, which no row carries. */
function rowKey(_row: unknown, index: number): number {
	return index;
}

</script>

<template>
	<div class="flex h-full min-h-0 flex-1 flex-col" data-slot="result-grid">
		<!-- Failure: the message, its code and where the server said it is. -->
		<div
			v-if="error"
			class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-4 text-center select-text"
		>
			<TriangleAlertIcon
				class="size-5 shrink-0 text-destructive"
				aria-hidden="true"
			/>
			<p class="text-xs text-muted-foreground">The statement failed</p>
			<p
				class="max-w-[36rem] break-words whitespace-pre-wrap font-mono text-xs text-foreground"
			>
				{{ error.message }}
			</p>
			<p
				v-if="error.detail"
				class="max-w-[36rem] break-words whitespace-pre-wrap text-[11px] text-muted-foreground"
			>
				{{ error.detail }}
			</p>
			<div class="mt-1 flex flex-wrap items-center justify-center gap-2 text-[11px] text-muted-foreground">
				<code class="rounded border border-border px-1 font-mono">{{ error.code }}</code>
				<span v-if="error.errorPosition" class="tabular-nums">
					Line {{ error.errorPosition.line }}, column {{ error.errorPosition.column }}
				</span>
			</div>
		</div>

		<template v-else>
			<ResultFilterBar
				:where="where"
				:order-by="orderBy"
				:sortable="filterable"
				:busy="busy"
				@update:where="(value) => emit('update:where', value)"
				@update:order-by="(value) => emit('update:orderBy', value)"
				@apply="emit('applyFilter')"
				@rerun="emit('rerun')"
			/>

			<!-- One horizontal scroller: the header sits above the vertical one. -->
			<div
				class="recall-scroll min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
				role="table"
				:aria-rowcount="rows.length"
				:aria-colcount="columns.length + 1"
				aria-label="Query results"
			>
				<div
					class="flex h-full min-h-0 flex-col"
					role="presentation"
					:style="gridStyle"
				>
					<div
						class="flex shrink-0"
						role="row"
						:style="{ height: `${HEADER_HEIGHT}px` }"
					>
						<div
							class="grid-header-cell grid-row-number"
							role="columnheader"
							:style="rowNumberStyle"
							aria-label="Row number"
						>
							#
						</div>
						<div
							v-for="(column, columnIndex) in columns"
							:key="column"
							class="grid-header-cell"
							role="columnheader"
							:style="cellStyleFor(column)"
							:title="column"
							:data-selected="columnIsSelected(columnIndex)"
							@click="onHeaderClick(columnIndex, $event)"
						>
							<span class="truncate">{{ column }}</span>
							<ArrowUp
								v-if="sortIcon(column) === 'asc'"
								class="size-3 shrink-0 text-primary"
								aria-hidden="true"
							/>
							<ArrowDown
								v-else-if="sortIcon(column) === 'desc'"
								class="size-3 shrink-0 text-primary"
								aria-hidden="true"
							/>
							<!-- The handle sits on the column's trailing edge; a
							     double-click on it restores the shared default. -->
							<div
								class="grid-column-resize"
								role="separator"
								aria-orientation="vertical"
								:aria-label="`Resize ${column}`"
								:title="`Resize ${column} — double-click to reset`"
								@pointerdown="startColumnResize($event, column)"
								@dblclick.stop="resetColumnWidth(column)"
							/>
						</div>
					</div>

					<div
						ref="scrollerEl"
						class="grid-body min-h-0 flex-1 overflow-y-auto outline-none"
						role="rowgroup"
						tabindex="0"
						:aria-activedescendant="selection.focus.value ? `cell-${selection.focus.value.row}-${selection.focus.value.col}` : undefined"
						@click="gridFocused = true"
						@focus="gridFocused = true"
						@blur="gridFocused = false"
						@keydown="onKeydown"
					>
						<RecycleScroller
							class="min-h-full"
							:items="rows"
							:key-field="rowKey"
							:item-size="ROW_HEIGHT"
							:buffer="240"
							:skip-hover="true"
						>
							<template #default="{ item, index }">
								<div class="grid-row flex" role="row" :style="rowStyle">
									<div
										class="grid-cell grid-row-number"
										role="cell"
										:style="rowNumberStyle"
										:data-selected="rowIsSelected(index)"
										@click="onRowNumberClick(index, $event)"
									>
										{{ index + 1 }}
									</div>
									<div
										v-for="(column, columnIndex) in columns"
										:key="column"
										:id="`cell-${index}-${columnIndex}`"
										class="grid-cell"
										role="cell"
										:style="cellStyleFor(column)"
										:data-row="index"
										:data-col="columnIndex"
										:data-null="isNullAt(index, columnIndexes[columnIndex] ?? 0)"
										:data-selected="selection.isSelected(index, columnIndex)"
										:data-active="selection.isActive(index, columnIndex)"
										:title="cellTitle(cellAt(item, columnIndexes[columnIndex] ?? 0))"
										@click="onCellClick(index, columnIndex, $event)"
										@pointerdown="onCellPointerDown(index, columnIndex, $event)"
										@dblclick="startEdit(index, columnIndex)"
									>
										<!-- The editor replaces the text in place so the row
										     never shifts and the surrounding selection stays visible. -->
										<input
											v-if="editing?.row === index && editing?.col === columnIndex"
											ref="editorEl"
											v-model="editing.draft"
											class="grid-cell-editor"
											@keydown.enter.prevent="commitEdit()"
											@keydown.tab.prevent="commitEdit({ row: index, col: columnIndex + 1 })"
											@keydown.esc.prevent="cancelEdit"
											@blur="commitEdit()"
										>
										<span v-else class="truncate">{{
											formatValue(cellAt(item, columnIndexes[columnIndex] ?? 0))
										}}</span>
									</div>
								</div>
							</template>
							<template #empty>
								<div class="px-3 py-6 text-center text-xs text-muted-foreground">
									No rows
								</div>
							</template>
						</RecycleScroller>
					</div>
				</div>
			</div>

			<!-- One row, three zones, exactly as DBX lays it out: what came back
			     and how long it took, the statement that produced it, then the
			     controls that act on it. The SQL is collapsed to a single line so
			     a multi-line statement cannot make the bar grow. -->
			<div class="result-statusbar" data-slot="result-statusbar">
				<div class="flex min-w-0 items-center gap-2 overflow-hidden">
					<span class="shrink-0 tabular-nums">
						{{ result.truncated ? "Loaded" : "Total" }} {{ rows.length }} rows
					</span>
					<span class="shrink-0 tabular-nums">{{ formatMs(result.executionTimeMs) }}</span>
					<span
						v-if="selection.selectedCellCount.value > 0"
						class="shrink-0 tabular-nums"
					>
						{{ selection.selectedCellCount.value }} cells selected
					</span>
					<span v-if="result.truncated" class="shrink-0 text-warning">
						truncated
					</span>
				</div>

				<span
					class="result-statusbar-sql"
					:title="oneLinerSql"
					role="button"
					tabindex="0"
					@click="copySql"
					@keydown.enter="copySql"
					@keydown.space.prevent="copySql"
				>
					{{ oneLinerSql }}
				</span>

				<div class="flex min-w-0 items-center gap-1">
					<Button
						size="micro"
						variant="ghost"
						:disabled="rows.length === 0"
						@click="emit('export', 'csv')"
					>
						<Download class="size-3" aria-hidden="true" />
						Export
					</Button>
				</div>
			</div>
		</template>
	</div>
</template>
