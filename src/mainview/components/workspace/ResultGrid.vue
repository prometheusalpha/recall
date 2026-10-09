<script setup lang="ts">
/**
 * Virtualised result grid with rectangular cell selection and inline editing,
 * hand-rolled on `vue-virtual-scroller` — no grid library. Header and body
 * share one horizontal scroll container, and explicit pixel cell widths keep
 * the columns aligned. Selection is addressed by absolute result indices,
 * never by what the scroller has in the DOM: a range reaches far past the
 * rendered rows, so copy and edit must work on values never painted.
 * The focused cell's value is read in full from a box pinned over the cells to
 * its right, opened by selection rather than by hover; a failure is data, so
 * `result.error` renders it centred.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { CSSProperties } from "vue";
import {
	ArrowDown,
	ArrowUp,
	ChevronLeft,
	ChevronRight,
	ChevronsLeft,
	Download,
	RefreshCw,
	TriangleAlertIcon,
} from "lucide-vue-next";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import type { StatementResult } from "../../../shared/types";
import {
	autoColumnWidth,
	GRID_CHAR_WIDTH,
	measureCharWidth,
	sampleColumnValues,
} from "../../lib/gridColumnWidth";
import { sumCells, type SumCell } from "../../lib/cellSum";
import { formatCellValue } from "../../lib/formatCell";
import {
	columnTypeClass,
	resolveColumnVisualKind,
} from "../../lib/gridColumnType";
import { toast } from "../../composables/useToast";
import { errorMessage, rpc } from "../../lib/rpc";
import {
	useGridSelection,
	type GridNavigationDirection,
} from "../../composables/useGridSelection";
import { useShortcuts } from "../../composables/useShortcuts";
import { registerResultFilterFocus } from "../../composables/useResultFilterFocus";
import { Button } from "../ui/button";
import {
	DropdownMenuCheckboxItem,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import ResultFilterBar from "./ResultFilterBar.vue";

const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 28;
const ROW_NUMBER_WIDTH = 56;
/** Fallback width for a column with no measurement and no override. */
const DEFAULT_COLUMN_WIDTH = 160;
/**
 * Floor for a MANUAL drag only. An auto width is allowed below it (down to
 * `GRID_MIN_AUTO_WIDTH`), and that is the whole point of the feature: an `id`
 * column holding `1..500` should read as the narrow column it is, and a 120px
 * floor made every such column look empty. The floor survives for the drag
 * because a user who can drag a column to zero has a column they cannot get
 * back by dragging it out again — only by the double-click, which is not a
 * gesture anyone reaches for on a collapsed column.
 */
const MIN_COLUMN_WIDTH = 120;

const props = withDefaults(
	defineProps<{
		/** One statement's outcome. */
		result: StatementResult;
		/**
		 * Last-resort width in px for a column nothing else sized: it is what
		 * a result with no rows at all falls back to. A result that has rows
		 * is auto-fitted from its content, and a dragged column keeps the
		 * width it was dragged to.
		 */
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
		/**
		 * 1-based page of the result set. A table tab pages; a query tab does
		 * not, and leaves this undefined so the pager renders nothing at all
		 * rather than showing controls that would do nothing.
		 */
		page?: number;
		/** Rows fetched per page. */
		pageSize?: number;
		/** Sizes the page-size menu offers. */
		pageSizeOptions?: number[];
		/** Whether the page that produced this result came back full. */
		hasNextPage?: boolean;
	}>(),
	{
		columnWidth: DEFAULT_COLUMN_WIDTH,
		editable: null,
		busy: false,
		where: "",
		orderBy: "",
		filterable: false,
		hiddenColumns: () => new Set<string>(),
		pageSize: 100,
		pageSizeOptions: () => [100, 500, 1000, 5000],
		hasNextPage: false,
	},
);

const emit = defineEmits<{
	/** Re-run the statement that produced this result. */
	rerun: [];
	/**
	 * The failure may be a dead session rather than bad SQL. The grid knows the
	 * error, not the connection, so it asks for one and the workspace owns the
	 * reconnect and the re-run.
	 */
	reconnect: [];
	/** The table tab's sort, so the caller can rebuild its SELECT. */
	sort: [column: string, direction: "asc" | "desc"];
	/** The toolbar asked for an export; the caller owns the folder picker. */
	export: [format: "csv" | "json"];
	"update:where": [value: string];
	"update:orderBy": [value: string];
	/**
	 * The caller wants the columns still visible. The filter bar reasons in
	 * terms of the visible list, the workspace owns the hidden set, so this is
	 * where one is turned into the other.
	 */
	"update:visibleColumns": [columns: string[]];
	/** Enter in either filter field: re-run the statement with the new filter. */
	applyFilter: [];
	/**
	 * The workspace owns the page and re-runs the statement; this grid never
	 * holds page state of its own, it only asks for another page.
	 */
	"update:page": [page: number];
	"update:pageSize": [size: number];
}>();

const error = computed(() => props.result.error);
const rows = computed(() => props.result.rows);

/**
 * Rows the current page starts after, so the gutter can number rows as if the
 * whole result set were loaded at once. Zero without a `page` prop, which is
 * how a query tab keeps its numbering starting at 1.
 */
const pageOffset = computed(() =>
	props.page === undefined ? 0 : (props.page - 1) * props.pageSize,
);

/**
 * A new page is a different set of rows at a different height; keeping the old
 * scroll position would open page 2 at the bottom of page 1 and show an empty
 * body that looks like the query returned nothing. The reset waits for the
 * next tick because the prop arrives with the new rows, not before them.
 */
watch(
	() => props.page,
	() => {
		void nextTick(() => {
			const body = scrollerNode();
			if (body) body.scrollTop = 0;
		});
	},
);

function goToPage(page: number): void {
	if (page < 1) return;
	emit("update:page", page);
}

function selectPageSize(size: number): void {
	if (size <= 0 || size === props.pageSize) return;
	// The new size changes how many rows precede this page, so staying put
	// would land on a different result entirely. Going back to the first page
	// is the only offset that means the same thing under both sizes.
	emit("update:pageSize", size);
	emit("update:page", 1);
}

/**
 * Columns the user has hidden. Owned by the workspace so the popover in the
 * context row and the columns rendered here can never disagree.
 */
const hiddenColumns = computed(() => props.hiddenColumns);
/**
 * Column order the user has dragged into place, keyed by name — the same
 * choice `columnWidths` makes, and for the same reason: hiding a different
 * column must not renumber the one that was moved.
 *
 * Empty means "the result's own order". The overlay is a view concern rather
 * than a rewrite of the statement, so it is discarded with the result it
 * described instead of being carried into the next one.
 */
const columnOrder = ref<string[]>([]);

const columns = computed(() => {
	const visible = props.result.columns.filter(
		(name) => !hiddenColumns.value.has(name),
	);
	const overlay = columnOrder.value;
	if (overlay.length === 0) return visible;
	// A name in the overlay can be hidden or absent from this result, and a
	// name can be missing from it; both have to be reconciled or the rendered
	// header and the row cells underneath it would disagree.
	const live = new Set(visible);
	const kept = overlay.filter((name) => live.has(name));
	if (kept.length === 0) return visible;
	const placed = new Set(kept);
	return [...kept, ...visible.filter((name) => !placed.has(name))];
});

/**
 * The filter bar ticks columns off its own list; the workspace stores the
 * hidden set. Converting here rather than in either of them keeps a single
 * source of truth for visibility — this grid already renders from
 * `hiddenColumns`, so a second copy would let the menu and the grid disagree.
 *
 * An empty `next` is a legitimate request (hide everything), not a mistake, so
 * only a non-array is dropped.
 */
function onVisibleColumnsChange(next: string[]): void {
	if (!Array.isArray(next)) return;
	const visible = new Set(next);
	emit(
		"update:visibleColumns",
		props.result.columns.filter((name) => !visible.has(name)),
	);
}
/** Result index of each rendered column, so selection survives hiding columns. */
const columnIndexes = computed(() =>
	columns.value.map((name) => props.result.columns.indexOf(name)),
);

const editable = computed(() => props.editable);

/**
 * Whether this result can be re-sorted at all.
 *
 * `filterable` is the gate, not `editable`: both mean "a table tab", but
 * `editable` additionally demands a primary key, and a keyless table is still
 * perfectly sortable — there is just nothing in it to UPDATE. `filterable` is
 * exactly the question "can the caller rebuild this statement?", which is what
 * emitting `sort` asks of it, and it is the same flag the filter bar already
 * reads as its own `sortable`.
 */
const sortable = computed(() => props.filterable);

/** Editing needs somewhere to send an UPDATE, so a keyless table is read-only. */
const canEdit = computed(
	() => editable.value !== null && editable.value.keyColumns.length > 0,
);

/**
 * Rows per screen, used by PageUp/PageDown. Derived from the scroller's own
 * height so it stays right when the split pane is dragged.
 */
const pageRows = ref(20);

/**
 * The header's own horizontal scroller.
 *
 * The body is the vertical scroller and it spans the full width of the pane,
 * so its scrollbar sits on the pane's right edge and stays there however far
 * the columns are scrolled. The header therefore cannot live inside that same
 * box — it would inherit the body's scroll position and scroll away with it.
 * It scrolls independently instead, and the two are tied together by
 * `syncHeaderScroll`, so a column header always sits over its own column.
 */
const headerScrollEl = ref<HTMLElement | null>(null);

/** The shape `ResultFilterBar` exposes via `defineExpose`. */
interface ResultFilterBarHandle {
	focusWhere: () => boolean;
}

/**
 * The filter band, held so the window shell's Cmd/Ctrl+L can move focus into
 * its WHERE box. Typed as `object` like `AppSidebar`'s tree handle, so this
 * file compiles whether or not the SFC's own types are visible, and recovered
 * by the cast in the callback published below.
 */
const filterBarEl = ref<object | null>(null);

/** Set while this grid is mounted; clears the shell's handle on the way out. */
let releaseFilterFocus: (() => void) | null = null;

/**
 * The element that actually scrolls.
 *
 * `RecycleScroller` is the scroller: it carries `overflow-y: auto` itself, so
 * `grid-body` around it never scrolls. Its item wrapper is pinned to
 * `width: 100%` — without that override wide columns spill out of the wrapper
 * instead of giving the scroller a horizontal range at all. Reading the node
 * off the component's root keeps `scrollLeft` and the header pairing on the
 * one element that has a range to scroll.
 */
function scrollerNode(): HTMLElement | null {
	return (recycleRef.value?.$el as HTMLElement | undefined) ?? null;
}

/**
 * Keeps the header aligned with the body.
 *
 * Assignment is guarded because setting `scrollLeft` fires a scroll event on
 * the header too: without the equality check the two push each other forever,
 * so the guard makes the pairing one-way per gesture. The value is clamped to
 * the header's own range, because a layout landing between a gutter
 * measurement and a scroll can leave one scroller shorter than the other.
 */
function syncHeaderScroll(): void {
	const body = scrollerNode();
	const header = headerScrollEl.value;
	if (!body || !header) return;
	const paired = clampScrollLeft(header, body.scrollLeft);
	if (header.scrollLeft !== paired) header.scrollLeft = paired;
}

/**
 * The same pairing from the other end: dragging the header's scrollbar moves
 * the body. The header is the one users reach for when the column they want is
 * off to the right, so it has to drive as well as follow.
 */
function syncBodyScroll(): void {
	const body = scrollerNode();
	const header = headerScrollEl.value;
	if (!body || !header) return;
	const paired = clampScrollLeft(body, header.scrollLeft);
	if (body.scrollLeft !== paired) body.scrollLeft = paired;
}

/** How far an element can travel horizontally; 0 while it cannot scroll. */
function maxScrollLeft(el: HTMLElement): number {
	return Math.max(0, el.scrollWidth - el.clientWidth);
}

function clampScrollLeft(el: HTMLElement, value: number): number {
	return Math.min(Math.max(value, 0), maxScrollLeft(el));
}


/**
 * The body's vertical scrollbar takes width out of its client box, so the body
 * travels further right than the header and the pairing clamps the header short
 * of it — leaving the last column's header to the left of its column. Widening
 * the header's content by the same gutter gives it the body's horizontal range.
 *
 * Overlay scrollbars report no gutter, so this settles at 0 on macOS; on a
 * platform with classic scrollbars it is the whole difference at the far right.
 */
const scrollbarGutter = ref(0);


function measureScrollbarGutter(): void {
	const body = scrollerNode();
	// A scroller with no layout yet reports zero for both measurements, which
	// is the same answer as "no scrollbar", so no special case is needed.
	const gutter = body ? Math.max(0, body.offsetWidth - body.clientWidth) : 0;
	if (gutter === scrollbarGutter.value) return;
	scrollbarGutter.value = gutter;
	// The header's range changed with it, so its scroll position may now be
	// out of range and the pairing has to be redone after the re-render.
	void nextTick(syncHeaderScroll);
}


const recycleRef = ref<{ $el: HTMLElement } | null>(null);
/**
 * The gutter is a layout measurement and no scroll event carries it: the pane
 * changes width when the split is dragged, and a short result makes the
 * vertical scrollbar disappear, both without either scroller scrolling.
 * Resizing the scroller element is the one source those changes reach.
 */
let scrollerResizeObserver: ResizeObserver | null = null;

watch(
	recycleRef,
	(scroller) => {
		scrollerResizeObserver?.disconnect();
		scrollerResizeObserver = null;
		const element = scroller?.$el;
		if (!(element instanceof HTMLElement)) return;
		scrollerResizeObserver = new ResizeObserver(() => {
			measureScrollbarGutter();
			// The box is placed against the body's box, so a pane that changed
			// size has to move it before the next selection does.
			measureBodyBox();
			// The font is read off a rendered cell, so a pane that changes
			// which cells are painted has to be allowed to re-read it.
			measureCellFont();
		});
		scrollerResizeObserver.observe(element);
		measureScrollbarGutter();
	},
	{ immediate: true, flush: "post" },
);

/**
 * Manual column widths, keyed by column name.
 *
 * **Presence of the key is the whole contract**: a key means "the user sized
 * this", and its value is the width to use — there is no separate user-sized
 * flag, because only a drag and the re-fit double-click write here. An absent
 * key auto-fits. Keying by name rather than index is what lets a width survive
 * hiding a different column, reordering, and re-running the statement.
 */
const columnWidths = ref<Record<string, number>>({});


/**
 * Advance width of one character in the grid's monospace face, in px.
 *
 * Starts at the library default because the first paint has no measured cell
 * to read a font off; `measureCellFont` replaces it as soon as there is one.
 */
const charWidth = ref(GRID_CHAR_WIDTH);

/**
 * Fitted width per visible column, keyed by name like `columnWidths`. Sampling
 * reads the RESULT column index, never the visible one: once a column is
 * hidden the visible indexes slide left, and measuring through them would size
 * each remaining column to its neighbour's values.
 *
 * Dependencies are exactly `props.result`, `columns`, `columnIndexes` and
 * `charWidth`: the sample is the expensive half, so a scroll or a selection
 * change must not re-run it, and `charWidth` carries the font re-measure.
 */
const autoColumnWidths = computed<Record<string, number>>(() => {
	const result = props.result;
	const fitted: Record<string, number> = {};
	columns.value.forEach((column, visibleIndex) => {
		const resultIndex = columnIndexes.value[visibleIndex];
		// A name can survive in `columns` that the result no longer carries
		// (a stale reorder overlay); there is nothing to sample for it.
		if (resultIndex === undefined || resultIndex < 0) return;
		fitted[column] = autoColumnWidth({
			header: column,
			values: sampleColumnValues(
				result.rows,
				resultIndex,
				result.columnTypes[resultIndex],
			),
			charWidth: charWidth.value,
		});
	});
	return fitted;
});

/** The caller's width, used when a column has neither an override nor a fit. */
const columnPixelWidth = computed(() => props.columnWidth);

/**
 * Width of one rendered column. Precedence is override → auto → the
 * `columnWidth` prop: a dragged column keeps its dragged width, an untouched
 * column re-fits on every new result or measurement, and the prop is the last
 * resort for a column with nothing to measure.
 *
 * Only the override is floored at {@link MIN_COLUMN_WIDTH}; an auto width is
 * left alone so it can go down to `GRID_MIN_AUTO_WIDTH`, since the 120px drag
 * floor would put back the empty-looking narrow columns the auto fit removes.
 */
function widthFor(column: string): number {
	const dragged = columnWidths.value[column];
	if (dragged !== undefined) return Math.max(MIN_COLUMN_WIDTH, dragged);
	return autoColumnWidths.value[column] ?? columnPixelWidth.value;
}

/**
 * Re-measures the character width against the font a rendered cell is painted
 * in, and re-fits anything the user has not sized.
 *
 * `getComputedStyle` on a live `.grid-cell` rather than a hardcoded shorthand:
 * the mono face is a CSS variable, so its size and family change with the
 * theme. Nothing is mutated, and with no cell rendered yet the library default
 * stays in place.
 */
function measureCellFont(): void {
	const cell = scrollerNode()?.querySelector<HTMLElement>(".grid-cell");
	if (!cell) return;
	const style = getComputedStyle(cell);
	const shorthand = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
	const measured = measureCharWidth(shorthand);
	if (measured > 0) charWidth.value = measured;
}

/**
 * The grid is mounted against a font that may not have loaded yet: the first
 * paint measures the fallback face, and every column sized against it stays
 * that way for the life of the result because nothing else changes
 * `charWidth`. `document.fonts.ready` is the one signal that the real face
 * has arrived, so the measurement is repeated once it resolves.
 */
onMounted(() => {
	void nextTick(measureCellFont);
	void nextTick(measureBodyBox);
	// The shell owns Cmd/Ctrl+L but cannot reach the WHERE box, so this grid
	// publishes a way in — and answers `false` when the filter bar has no box
	// on screen (a query tab), so the shell leaves the chord to the webview.
	releaseFilterFocus = registerResultFilterFocus(() => {
		const bar = filterBarEl.value as ResultFilterBarHandle | null;
		return bar?.focusWhere() ?? false;
	});
	// The box closes on a press outside the grid, which no other listener here
	// sees: the pointer lands in another pane entirely.
	document.addEventListener("pointerdown", onDocumentPointerDown);
	void document.fonts?.ready.then(() => {
		void nextTick(measureCellFont);
	});
});

/**
 * Re-fits the columns whenever the set of rendered cells changes underneath
 * the measurement — a new result paints different cells, and an emptied or
 * refilled body would otherwise leave `charWidth` describing a cell that no
 * longer exists.
 */
watch(rows, () => {
	void nextTick(measureCellFont);
});

function totalWidthFor(list: string[]): number {
	return ROW_NUMBER_WIDTH + list.reduce((sum, column) => sum + widthFor(column), 0);
}

const totalWidth = computed(() => totalWidthFor(columns.value));
const headerContentStyle = computed<CSSProperties>(() => ({
	width: `${totalWidth.value + scrollbarGutter.value}px`,
}));

// A column resize or a column being hidden changes the content width, which
// clamps whichever scroller is scrolled furthest right. Re-pairing after the
// DOM settles keeps the header from being left behind at a stale offset.
watch([totalWidth, columns], () => {
	void nextTick(() => {
		measureScrollbarGutter();
		syncHeaderScroll();
	});
});

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

/**
 * The sum over the SELECTED RECTANGLE, or `null` when there is no selection —
 * so the statusbar renders nothing at all rather than a misleading `Sum 0`.
 * Non-numeric cells (NULL, text, JSON) are SKIPPED and counted rather than
 * coerced, and the raw value is read through `cellAt` instead of the formatted
 * text, because separators or a suffix in a display string would make a
 * perfectly good number look non-numeric.
 *
 * The declared column type travels with each cell: `Bun.SQL` returns a Postgres
 * `numeric`/`bigint`/`money` as a string, and without the type `sumCells` would
 * skip the whole column.
 */
const selectionSum = computed<ReturnType<typeof sumCells> | null>(() => {
	const r = selection.range.value;
	if (!r || selection.selectedCellCount.value === 0) return null;
	const cells: SumCell[] = [];
	for (let row = r.startRow; row <= r.endRow; row++) {
		for (let col = r.startCol; col <= r.endCol; col++) {
			// `col` indexes the VISIBLE columns, so it has to be translated
			// through `columnIndexes` before it can address the result row —
			// otherwise hiding a column shifts every value to its right.
			const resultCol = columnIndexes.value[col];
			if (resultCol === undefined) continue;
			cells.push({
				value: cellAt(rows.value[row], resultCol),
				columnType: props.result.columnTypes[resultCol],
			});
		}
	}
	return sumCells(cells);
});

/** The grid owns focus while the user is navigating cells, so arrows move the
 *  cursor instead of scrolling the page. */
const gridFocused = ref(false);

/** Sort indicator: the column the caller last sorted by, and how. */
const sortColumn = ref<string | null>(null);
const sortDirection = ref<"asc" | "desc">("asc");

/**
 * Sets the sort outright. The header menu states the direction the user picked
 * rather than stepping through one, because "which way" is a choice, not a
 * step in a sequence — so there is no cycle to fast-click through by accident.
 */
function setSort(column: string, direction: "asc" | "desc"): void {
	if (!sortable.value) return;
	sortColumn.value = column;
	sortDirection.value = direction;
	emit("sort", column, direction);
}

/**
 * Drops the ORDER BY. An empty column is the caller's long-standing contract
 * for "no sort at all"; it ignores the direction, but the signature has no
 * optional direction and changing it would reach into the workspace.
 */
function clearSort(): void {
	if (!sortable.value) return;
	sortColumn.value = null;
	emit("sort", "", "asc");
}

/**
 * Ctrl+Shift+ArrowUp / Ctrl+Shift+ArrowDown, resolved through the shortcut
 * table so the chord is rebindable and printable like every other command.
 * Handled here rather than in App.vue's window dispatcher — the mirror of the
 * bookmark-jump decision there: a jump must work from anywhere, a sort needs
 * a focused cell, so from the grid's own `onKeydown` the event only arrives
 * while this grid holds focus, and `preventDefault` claims it to `match`. It
 * runs first, ahead of the accel branches and the `NAVIGATION_KEYS` fallback,
 * so a rebound chord beats the grid's own keys; a held chord is one action.
 */
const { match } = useShortcuts();

/**
 * Claims the refresh chord the shortcut table lists but the window dispatcher
 * never runs. A sort needs a focused cell; a refresh only needs the grid, so
 * both end at the same `rerun` the old Refresh button emitted.
 */
function rerunFromShortcut(event: KeyboardEvent): boolean {
	if (match(event) !== "result.rerun") return false;
	// A held chord would re-issue the statement on every key repeat.
	if (event.repeat) return true;
	// Claimed before the guard below: the webview must never run its own
	// reload on a chord the app has already given a meaning to.
	event.preventDefault();
	if (props.busy) return true;
	emit("rerun");
	return true;
}

function sortFromShortcut(event: KeyboardEvent): boolean {
	const id = match(event);
	if (id !== "result.sortAsc" && id !== "result.sortDesc") return false;
	// A sort is not a cursor move: it re-runs the statement against the
	// server, so a held chord must be one action and not a stream of reloads.
	if (event.repeat) return true;
	// Claimed either way: the webview must not scroll the grid or walk a caret
	// on a chord the app has already given a meaning to.
	event.preventDefault();
	if (!sortable.value) return true;
	const focus = selection.focus.value;
	if (focus === null) return true;
	// `focus.col` indexes the *visible* columns — the same list the header and
	// the row cells are rendered from — so this is the name `setSort` wants.
	const column = columns.value[focus.col] ?? "";
	if (column === "") return true;
	setSort(column, id === "result.sortAsc" ? "asc" : "desc");
	return true;
}

/** True while the grid is showing the result of some column's sort. */
const hasSort = computed(() => sortColumn.value !== null);

/** The column the header menu is open on; null while the menu is closed. */
const menuColumn = ref<string | null>(null);
const menuOpen = ref(false);
/**
 * Virtual anchor for the header menu. `DropdownMenu` positions its content
 * against the trigger element, so a zero-size element parked at the pointer is
 * what puts the menu under the cursor rather than under the whole header.
 */
const menuAnchor = ref({ x: 0, y: 0 });

function openHeaderMenu(column: string, x: number, y: number): void {
	menuColumn.value = column;
	menuAnchor.value = { x, y };
	menuOpen.value = true;
}

function onHeaderContextMenu(column: string, event: MouseEvent): void {
	if (!sortable.value) return;
	// The resize handle stops the `pointerdown` that starts a drag, but a
	// `contextmenu` is a separate event and still bubbles to the cell, so the
	// handle has to be recognised by what was hit rather than assumed away.
	const target = event.target instanceof Element ? event.target : null;
	if (target?.closest(".grid-column-resize")) return;
	event.preventDefault();
	openHeaderMenu(column, event.clientX, event.clientY);
}

/**
 * Keyboard route to the same menu: the ContextMenu key, Shift+F10, and the
 * menu key some keyboards send on their own. No pointer means no coordinates,
 * so the menu hangs off the header's own top-left corner.
 */
function onHeaderKeydown(column: string, event: KeyboardEvent): void {
	if (!sortable.value) return;
	const isMenuKey =
		event.key === "ContextMenu" ||
		(event.key === "F10" && event.shiftKey) ||
		event.key === "Menu";
	if (!isMenuKey) return;
	// The grid owns the arrow keys and Escape; a menu key must not reach it.
	event.preventDefault();
	event.stopPropagation();
	const cell = event.currentTarget;
	if (!(cell instanceof HTMLElement)) return;
	const rect = cell.getBoundingClientRect();
	openHeaderMenu(column, rect.left, rect.bottom);
}

/** Menu entries, so the template never has to reach past a null column. */
function sortMenuAscending(): void {
	if (menuColumn.value === null) return;
	setSort(menuColumn.value, "asc");
}

function sortMenuDescending(): void {
	if (menuColumn.value === null) return;
	setSort(menuColumn.value, "desc");
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

/**
 * Reorder state. `drop` is the index the dragged column would take in the list
 * *with itself removed*, which is what makes dropping it back on its own slot
 * compare equal to `from` and therefore a no-op.
 *
 * `moved` is the threshold latch: a press that has not travelled a few pixels
 * is a click, and a click on a header is a selection. Committing on
 * `pointerdown` would turn every header click into a reorder.
 */
const REORDER_THRESHOLD_PX = 4;
const columnDrag = ref<{
	column: string;
	from: number;
	startX: number;
	moved: boolean;
	drop: number;
} | null>(null);
/** The header cell showing where the drop lands, and on which of its edges. */
const dropMarker = ref<{ column: string; edge: "leading" | "trailing" } | null>(null);

/**
 * A drag that crossed the threshold still ends with a `click` when it is
 * released over the cell it started on. Reordering and selecting are separate
 * intentions, so that click is swallowed; the next press re-arms it.
 */
let headerClickSuppressed = false;

/**
 * Like the resize, a reorder has to keep tracking the pointer once it leaves
 * the header, so the move and release handlers live on the window.
 *
 * No `preventDefault()` here, unlike the resize: the default action is what
 * focuses a header cell, and the ContextMenu/Shift+F10 route reads its anchor
 * from the focused cell. Stopping propagation is enough to keep the press out
 * of the resize handle's way, which is the direction that actually needs it.
 */
function startColumnDrag(event: PointerEvent, column: string, index: number): void {
	if (event.button !== 0 || columnDrag.value) return;
	// The handle stops the `pointerdown` that reaches the cell, but that is an
	// accident of listener order rather than a contract, so the handle is
	// recognised by what was hit — the guard `onHeaderContextMenu` already uses
	// for the same reason.
	const target = event.target instanceof Element ? event.target : null;
	if (target?.closest(".grid-column-resize")) return;
	headerClickSuppressed = false;
	columnDrag.value = { column, from: index, startX: event.clientX, moved: false, drop: index };
	document.addEventListener("selectionchange", blockNativeSelection);
	window.addEventListener("pointermove", onColumnDragMove);
	window.addEventListener("pointerup", endColumnDrag, { once: true });
	window.addEventListener("pointercancel", cancelColumnDrag, { once: true });
	window.addEventListener("keydown", onColumnDragKeydown);
}

/**
 * How many of the *other* columns the pointer has passed the midpoint of.
 *
 * Midpoint comparison is exact here rather than approximate: every header cell
 * carries an explicit pixel width, so there is no guessed geometry to disagree
 * with. Cells scrolled out of view still report a rect, which is what clamps the
 * result to the ends of the list.
 */
function dropIndexFor(clientX: number, column: string): number {
	const header = headerScrollEl.value;
	if (!header) return 0;
	const cells = header.querySelectorAll<HTMLElement>(".grid-header-cell[data-col]");
	let index = 0;
	for (const cell of cells) {
		// The dragged column is lifted out of the count, so reaching the end of
		// the list means crossing the midpoint of every other header.
		if (columns.value[Number(cell.dataset.col)] === column) continue;
		const rect = cell.getBoundingClientRect();
		if (clientX < rect.left + rect.width / 2) break;
		index += 1;
	}
	return index;
}

/**
 * Where the indicator goes.
 *
 * A flex row has no gap to hang a rule in, so the rule sits on the edge of the
 * column the drop displaces: the leading edge of the one about to be pushed
 * aside, or the trailing edge of the last one when the drop is past the end.
 * That index is derived from the rendered list, which still contains the dragged
 * column in place, so a drop to the right of the source has to be read one slot
 * further along.
 */
function updateDropMarker(column: string, from: number, drop: number): void {
	// A drop onto its own slot moves nothing, so there is nowhere to land and
	// no rule to draw; showing one would promise a move that will not happen.
	if (drop === from) {
		dropMarker.value = null;
		return;
	}
	const list = columns.value;
	const target = drop + (drop >= from ? 1 : 0);
	if (target >= list.length) {
		const last = list[list.length - 1];
		// Dragging the last column further right has nowhere to go, and a rule on
		// the column being dragged would promise a move that cannot happen.
		dropMarker.value = last === undefined || last === column
			? null
			: { column: last, edge: "trailing" };
		return;
	}
	const name = list[target];
	dropMarker.value =
		name === undefined || name === column ? null : { column: name, edge: "leading" };
}

function onColumnDragMove(event: PointerEvent): void {
	const drag = columnDrag.value;
	if (!drag) return;
	const moved = drag.moved || Math.abs(event.clientX - drag.startX) >= REORDER_THRESHOLD_PX;
	const drop = moved ? dropIndexFor(event.clientX, drag.column) : drag.drop;
	columnDrag.value = { ...drag, moved, drop };
	if (!moved) return;
	headerClickSuppressed = true;
	updateDropMarker(drag.column, drag.from, drop);
}

function endColumnDrag(): void {
	const drag = columnDrag.value;
	const drop = drag?.drop ?? 0;
	stopColumnDrag();
	if (!drag || !drag.moved) return;
	reorderColumn(drag.from, drop);
}

/** Escape abandons the gesture; the order overlay is only written on a commit. */
function onColumnDragKeydown(event: KeyboardEvent): void {
	if (event.key !== "Escape" || !columnDrag.value) return;
	cancelColumnDrag();
}

function cancelColumnDrag(): void {
	stopColumnDrag();
}

function stopColumnDrag(): void {
	columnDrag.value = null;
	dropMarker.value = null;
	document.removeEventListener("selectionchange", blockNativeSelection);
	window.removeEventListener("pointermove", onColumnDragMove);
	window.removeEventListener("pointerup", endColumnDrag);
	window.removeEventListener("pointercancel", cancelColumnDrag);
	window.removeEventListener("keydown", onColumnDragKeydown);
}

/**
 * Where a visible column index ended up after one move. The selection is
 * addressed by visible index, so without this a reorder would silently slide
 * the highlight onto whichever column inherited the index the user had picked.
 */
function movedColumnIndex(index: number, from: number, to: number): number {
	if (index === from) return to;
	if (from < to && index > from && index <= to) return index - 1;
	if (from > to && index >= to && index < from) return index + 1;
	return index;
}

function reorderColumn(from: number, to: number): void {
	const current = columns.value;
	if (from < 0 || to < 0 || to >= current.length || from === to) return;
	const next = [...current];
	const [moved] = next.splice(from, 1);
	if (moved === undefined) return;
	next.splice(to, 0, moved);
	columnOrder.value = next;
	const anchor = selection.anchor.value;
	const focus = selection.focus.value;
	if (anchor) {
		selection.anchor.value = { row: anchor.row, col: movedColumnIndex(anchor.col, from, to) };
	}
	if (focus) {
		selection.focus.value = { row: focus.row, col: movedColumnIndex(focus.col, from, to) };
	}
}

/**
 * Writes the dragged width. This is also what MARKS the column as user-sized —
 * the first move writes the key, and from then on `widthFor` reads the
 * override and ignores the fit, so no later result, hide or re-measure can
 * snap the column back while the pointer is still down.
 *
 * The floor is {@link MIN_COLUMN_WIDTH} rather than the auto minimum: a drag
 * is a hand gesture and must not be able to collapse a column to nothing.
 */
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

/**
 * Double-click drops the manual width so the column goes back to fitting its
 * content — "reset to default" would be the wrong name now that the width it
 * restores is the fitted one, which changes with every result.
 *
 * Deleting the key is the whole operation: it is the only thing that clears
 * the user-sized marker, so it cannot be faked by writing a width. Guarded on
 * absence so a double-click on an already-fitted column does not churn the map.
 */
function refitColumnWidth(column: string): void {
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
	return formatValue(cellAt(rows.value[row], resultCol), resultCol);
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

/**
 * The colour bucket of every result column, resolved once per result rather
 * than once per painted cell: a column's type is fixed, and this grid repaints
 * whole rows as they scroll.
 */
const columnVisualKinds = computed(() =>
	props.result.columnTypes.map((type) => resolveColumnVisualKind(type)),
);

/**
 * The class that paints a cell's text by its column's type.
 *
 * `undefined` on a NULL, because the cell already says `NULL` in a muted
 * italic and a type colour on it would read as a value. `undefined` again for
 * a type no bucket claimed, which leaves the cell on the inherited foreground.
 */
function cellTypeClass(row: number, visibleColumn: number): string | undefined {
	const resultColumn = columnIndexes.value[visibleColumn] ?? 0;
	if (isNullAt(row, resultColumn)) return undefined;
	return columnTypeClass(columnVisualKinds.value[resultColumn] ?? "unknown");
}

/**
 * The header/row-number chrome for a whole column or row selection.
 *
 * Only when the rectangle genuinely covers the column top to bottom. Testing
 * row 0 alone — which is what this did — made a click on any cell in the first
 * row light the header, so one selected cell in the top row read as "the whole
 * column is selected". A header click runs from row 0 to the last row, so a
 * real whole-column selection still lights it.
 */
function columnIsSelected(col: number): boolean {
	const last = rows.value.length - 1;
	if (last < 0) return false;
	const range = selection.range.value;
	if (!range) return false;
	return (
		range.startRow === 0 &&
		range.endRow === last &&
		col >= range.startCol &&
		col <= range.endCol
	);
}

/**
 * Whether the gutter cell for this row is painted as selected.
 *
 * Only when the rectangle genuinely covers the row end to end. Testing the
 * last column instead — which is what this did — made a click on any single
 * cell there light the whole gutter, so one selected cell in the rightmost
 * column read as "the whole row is selected". The gutter click and its
 * shift-click both run to column 0 and back, so a real whole-row selection
 * still lights it.
 */
function rowIsSelected(row: number): boolean {
	const last = columns.value.length - 1;
	if (last < 0) return false;
	const range = selection.range.value;
	if (!range) return false;
	return (
		range.startCol === 0 &&
		range.endCol === last &&
		row >= range.startRow &&
		row <= range.endRow
	);
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
 *
 * A shift-press keeps the existing anchor instead of re-seeding it, so a
 * shift-click or shift-drag extends from where the selection started. Without
 * this the pointerdown would collapse the anchor onto the pressed cell and the
 * following click's `extendSelectionTo` would find nothing left to extend from,
 * leaving every shift-click a single cell.
 */
const dragging = ref(false);

function onCellPointerDown(row: number, col: number, event: PointerEvent): void {
	if (event.button !== 0 || dragging.value) return;
	dragging.value = true;
	if (event.shiftKey) selection.extendSelectionTo({ row, col });
	else selection.selectCell({ row, col });
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
 *  Clearing a selection inside an input is what breaks select-all and paste.
 *
 *  The header cells are `user-select: none`, but a reorder's pointer travels
 *  down over the body on the way, and the cells there are selectable text. */
function blockNativeSelection(): void {
	if (!dragging.value && !columnDrag.value) return;
	const active = document.getSelection();
	if (!active || active.isCollapsed) return;
	if (insideTextField(active.anchorNode) || insideTextField(active.focusNode)) return;
	active.removeAllRanges();
}

onBeforeUnmount(() => {
	stopCellDrag();
	stopColumnResize();
	stopColumnDrag();
	releaseFilterFocus?.();
	releaseFilterFocus = null;
	document.removeEventListener("pointerdown", onDocumentPointerDown);
	scrollerResizeObserver?.disconnect();
	scrollerResizeObserver = null;
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
 * A header click only ever *selects*: a plain click collapses the selection
 * onto the column, a shift-click extends from the existing anchor. Sorting
 * moved to the context menu — a click that re-runs the statement is one the
 * user cannot take back, and choosing and ordering are separate intentions.
 *
 * A drag past the reorder threshold ends with a `click` on the cell it started
 * from, and that click is discarded rather than re-selecting the column that
 * moved. The flag clears on the next press, so a real click is never lost.
 */
function onHeaderClick(col: number, event: MouseEvent): void {
	if (headerClickSuppressed) {
		headerClickSuppressed = false;
		return;
	}
	const last = rows.value.length - 1;
	if (last < 0) return;
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

	// Ahead of the accel branches and the `NAVIGATION_KEYS` fallback: a rebound
	// chord has to win here, and `ArrowUp`/`ArrowDown` with a modifier held
	// must not fall through to vertical caret movement.
	if (rerunFromShortcut(event)) return;
	if (sortFromShortcut(event)) return;

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
		const container = scrollerNode();
		if (!container) return;
		const top = next.row * ROW_HEIGHT;
		const bottom = top + ROW_HEIGHT;
		if (top < container.scrollTop) container.scrollTop = top;
		else if (bottom > container.scrollTop + container.clientHeight) {
			container.scrollTop = bottom - container.clientHeight;
		}

		// The horizontal counterpart of the above: a cell can walk off the
		// right edge exactly as a row walks off the bottom, and without this
		// arrowing right simply stopped moving the caret once the column was
		// past the viewport. `next.col` indexes the *visible* columns — the
		// same list the row cells are rendered from — so its left edge is the
		// row-number gutter plus the widths of the columns before it.
		const column = columns.value[next.col];
		if (column === undefined) return;
		const left =
			ROW_NUMBER_WIDTH +
			columns.value
				.slice(0, next.col)
				.reduce((sum, name) => sum + widthFor(name), 0);
		const right = left + widthFor(column);
		// Both edges are measured in CONTENT coordinates, and the row-number
		// gutter is sticky INSIDE the scrolled content — it never leaves the
		// viewport, so it permanently occludes the band of content that spans
		// `[scrollLeft, scrollLeft + ROW_NUMBER_WIDTH]`. The left edge of what
		// is actually visible is therefore one gutter to the right of the raw
		// scrollport edge, and the right edge is the raw one. Measuring the left
		// side against `scrollLeft` alone parks column 0 at `scrollLeft = 56`
		// with its first 56px hidden under the pin — which is what made arrowing
		// left stop short of the edge.
		if (left < container.scrollLeft + ROW_NUMBER_WIDTH) {
			container.scrollLeft = left - ROW_NUMBER_WIDTH;
		} else if (right > container.scrollLeft + container.clientWidth) {
			container.scrollLeft = right - container.clientWidth;
		} else {
			return;
		}
		// The body's scroll event would eventually carry this to the header, but
		// an assignment made in the same tick as a layout change can land before
		// the browser dispatches it, leaving the header a frame behind.
		syncHeaderScroll();
	});
}

/** A fresh result invalidates every grid-local affordance tied to the old rows. */
watch(
	() => props.result,
	() => {
		selection.clear();
		editing.value = null;
		// The order overlay described the old result's columns. Carrying it over
		// would apply a drag the user made to a shape that no longer exists, and
		// the reconciliation in `columns` would quietly append the new columns to
		// the end of an order they were never part of.
		columnOrder.value = [];
		stopColumnDrag();
		// A new result can be short enough to lose the body's vertical
		// scrollbar, which changes the header's horizontal range.
		void nextTick(measureScrollbarGutter);
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

/**
 * 1-based, and global across pages: page 2 of a 1000-row page starts at 1001,
 * not 1. A user comparing two pages reads these as positions in one result set,
 * so numbering per page would silently point them at the wrong rows.
 *
 * The gutter cell and its tooltip both read this rather than repeating the
 * arithmetic. `RecycleScroller` hands a pooled view a new row without
 * remounting it, so two copies of the arithmetic are two chances to quote a
 * different row than the cell the pointer is actually on.
 */
function rowNumberLabel(index: number): string {
	return String(index + 1 + pageOffset.value);
}


function isNullValue(value: unknown): boolean {
	return value === null || value === undefined;
}

/**
 * A cell as the text it shows. `resultColumn` indexes the result's own
 * `columnTypes`, which is what separates an instant from a wall clock — after
 * `toJsonSafe` both are ISO strings, so the type name is the only signal left.
 */
function formatValue(value: unknown, resultColumn: number): string {
	return formatCellValue(value, props.result.columnTypes[resultColumn]);
}

/** Body text: a NULL cell shows a dim `NULL` marker instead of reading as blank. Editing and copy keep using the raw `formatValue`. */
function cellDisplayValue(value: unknown, resultColumn: number): string {
	if (isNullValue(value)) return "NULL";
	return formatValue(value, resultColumn);
}

/**
 * Full value of a cell, for the box that reveals what CSS truncation hides.
 *
 * `undefined` for an empty cell is the whole reason this is not just
 * `formatValue`: an empty cell has no tail to reveal, and a box over it would
 * be an empty box over an empty cell.
 */
function cellFullText(value: unknown, resultColumn: number): string | undefined {
	if (isNullValue(value)) return "NULL";
	const text = formatValue(value, resultColumn);
	return text.length > 0 ? text : undefined;
}

/**
 * The box that shows the focused cell's value in full, over the cells to its
 * right. Selection opens it, never hover: a grid is read by sweeping the
 * pointer along a row, and a box per crossed cell would strobe.
 *
 * One box for the whole grid rather than one per cell. The body is a
 * `RecycleScroller` pool, so a box per rendered cell is pooled-rows × columns
 * elements for a surface that has exactly one focused cell.
 *
 * Its geometry comes from the scroll offsets and the column widths, never from
 * the DOM: the arrow keys walk the focus past the rendered window, and a box
 * that had to find its own cell in the DOM would come up empty exactly then.
 */
const PEEK_MAX_WIDTH = 560;
/** Keeps the box clear of the pane's right edge, where the scrollbar sits. */
const PEEK_RIGHT_MARGIN = 4;

const gridRootEl = ref<HTMLElement | null>(null);

/** The body's viewport, in the root's coordinates. */
const bodyBox = ref({ left: 0, top: 0, width: 0, height: 0 });
const bodyScroll = ref({ top: 0, left: 0 });

/** The layer starts right of the pinned gutter, which must stay on top. */
const peekLayerWidth = computed(() =>
	Math.max(0, bodyBox.value.width - ROW_NUMBER_WIDTH),
);

const peekLayerStyle = computed<CSSProperties>(() => ({
	left: `${bodyBox.value.left + ROW_NUMBER_WIDTH}px`,
	top: `${bodyBox.value.top}px`,
	width: `${peekLayerWidth.value}px`,
	height: `${bodyBox.value.height}px`,
}));

/**
 * Set by a press outside the grid, cleared by the next selection. Dropping the
 * box but keeping the selection is deliberate: a click in the connection tree
 * is not a request to forget what is selected here.
 */
const peekDismissed = ref(false);

/** The focused cell, its raw value and that value as text, or null when closed. */
const peekCell = computed<{
	row: number;
	col: number;
	value: unknown;
	text: string | null;
} | null>(() => {
	if (peekDismissed.value || editing.value !== null) return null;
	const focus = selection.focus.value;
	if (!focus) return null;
	const resultColumn = columnIndexes.value[focus.col];
	if (resultColumn === undefined) return null;
	const value = cellAt(rows.value[focus.row], resultColumn);
	return {
		row: focus.row,
		col: focus.col,
		value,
		text: cellFullText(value, resultColumn) ?? null,
	};
});

const peekText = computed(() => peekCell.value?.text ?? null);
const peekIsNull = computed(() => isNullValue(peekCell.value?.value));
/** The box is the focused cell grown, so it carries that cell's type colour. */
const peekTypeClass = computed(() =>
	peekIsNull.value
		? undefined
		: cellTypeClass(peekCell.value?.row ?? 0, peekCell.value?.col ?? 0),
);

/**
 * Where the box goes inside the layer, or null while it stays closed.
 *
 * `max-content` so the value reads in one line however far it runs, floored at
 * the column's own width — any narrower and the cell's truncated text would
 * show beside the box — and capped so a long JSON value cannot run away.
 */
const peekStyle = computed<CSSProperties | null>(() => {
	const cell = peekCell.value;
	if (!cell || cell.text === null) return null;
	const left =
		columns.value
			.slice(0, cell.col)
			.reduce((sum, name) => sum + widthFor(name), 0) - bodyScroll.value.left;
	const room = peekLayerWidth.value - left - PEEK_RIGHT_MARGIN;
	return {
		left: `${left}px`,
		top: `${cell.row * ROW_HEIGHT - bodyScroll.value.top}px`,
		width: "max-content",
		minWidth: `${widthFor(columns.value[cell.col] ?? "")}px`,
		maxWidth: `${Math.max(0, Math.min(PEEK_MAX_WIDTH, room))}px`,
	};
});

/**
 * Measures the body's viewport and re-reads the scroll offsets in one pass. The
 * box is pinned inside a layer clipped to that rectangle, which is what keeps
 * it out of the header, the status bar, the scrollbar and the gutter.
 */
function measureBodyBox(): void {
	const body = scrollerNode();
	const root = gridRootEl.value;
	if (!body || !root) return;
	const bodyRect = body.getBoundingClientRect();
	const rootRect = root.getBoundingClientRect();
	bodyBox.value = {
		left: bodyRect.left - rootRect.left + body.clientLeft,
		top: bodyRect.top - rootRect.top + body.clientTop,
		width: body.clientWidth,
		height: body.clientHeight,
	};
	bodyScroll.value = { top: body.scrollTop, left: body.scrollLeft };
}

/** A press anywhere but the grid closes the box; the selection stays. */
function onDocumentPointerDown(event: PointerEvent): void {
	if (peekText.value === null) return;
	const root = gridRootEl.value;
	if (root && event.target instanceof Node && root.contains(event.target)) return;
	peekDismissed.value = true;
}

/**
 * A fresh focus is a fresh request for the box, and the press that caused it is
 * also the moment the pane may have been resized while nothing was focused and
 * no scroll event carried it.
 */
watch(selection.focus, () => {
	// `onBodyScroll` skips the offsets while nothing is open, so a focus that
	// opens the box has to read them itself.
	const body = scrollerNode();
	if (body) bodyScroll.value = { top: body.scrollTop, left: body.scrollLeft };
	if (peekDismissed.value) measureBodyBox();
	peekDismissed.value = false;
});

/**
 * The body's scroll event. The box is placed by coordinates, so it has to be
 * told where the content moved to, or it would sit over the wrong row.
 *
 * The offsets are written only while a box is open. Writing them on every
 * scroll frame re-rendered the whole grid even with nothing open, which is
 * exactly when the rows need the main thread free to stay painted; the focus
 * watcher re-reads them when a box opens.
 */
function onBodyScroll(): void {
	syncHeaderScroll();
	if (peekCell.value === null) return;
	const body = scrollerNode();
	if (body) bodyScroll.value = { top: body.scrollTop, left: body.scrollLeft };
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
	<div
		ref="gridRootEl"
		class="relative flex h-full min-h-0 flex-1 flex-col"
		data-slot="result-grid"
	>
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
			<Button variant="outline" size="sm" :disabled="busy" @click="emit('reconnect')">
				<RefreshCw aria-hidden="true" />
				Reconnect
			</Button>
		</div>

		<template v-else>
			<ResultFilterBar
				ref="filterBarEl"
				:where="where"
				:order-by="orderBy"
				:sortable="filterable"
				:busy="busy"
				:columns="result.columns"
				:column-types="result.columnTypes"
				:visible-columns="columns"
				@update:where="(value) => emit('update:where', value)"
				@update:order-by="(value) => emit('update:orderBy', value)"
				@update:visible-columns="onVisibleColumnsChange"
				@apply="emit('applyFilter')"
			/>

		<!--
		     The header scrolls horizontally on its own, above a body that
		     scrolls vertically. Nesting the header inside the body's scroller is
		     what put the scrollbar in the wrong place: a scroller is as wide as
		     its content, so a scrollbar belonging to a container that spans the
		     columns travels with them and slides away on a horizontal scroll.
		     Two scrollers tied together by `syncHeaderScroll` keep the scrollbar
		     pinned to the pane's right edge, which is also what makes the last
		     column's right border land beside it rather than under it. -->
		<div
			ref="headerScrollEl"
			class="grid-header-scroll shrink-0 overflow-x-auto overflow-y-hidden"
			role="row"
			:style="{ height: `${HEADER_HEIGHT}px` }"
			@scroll="syncBodyScroll"
		>
			<!-- `headerContentStyle`, not the bare `totalWidth`: the body's
			     vertical scrollbar makes its horizontal range the wider of the
			     two, and matching that range is what keeps the rightmost
			     header over its column. See `measureScrollbarGutter`. -->
			<div
				class="flex h-full"
				role="presentation"
				:style="headerContentStyle"
			>
			<!-- The gutter is reference rather than content, which makes its
			     header the one cell in the row whose meaning is not in its own
			     text. The trigger is the cell, so nothing about the pin moves. -->
			<Tooltip>
				<TooltipTrigger as-child>
					<div
						class="grid-header-cell grid-row-number"
						role="columnheader"
						:style="rowNumberStyle"
						aria-label="Row number"
					>
						#
					</div>
				</TooltipTrigger>
				<TooltipContent class="max-w-lg">
					Row number — 1-based position across all pages
				</TooltipContent>
			</Tooltip>
			<!-- `tabindex`/`aria-haspopup` because a sort is now a menu: a pointer is
			     not the only way to open it, and `aria-label` names the column for a
			     screen reader that would otherwise read the truncated text.

			     The trigger is the cell rather than the label span: it merges its
			     listeners onto the child and never calls `preventDefault`, so the
			     drag, the click, the menu and the keyboard route all reach the same
			     element and the tooltip anchors to the whole column. Disabled during
			     a reorder, which walks the pointer across every other header; `disabled`
			     rather than `v-if` because unmounting would unmount the drag's cell. -->
			<Tooltip
				v-for="(column, columnIndex) in columns"
				:key="column"
				:disabled="columnDrag !== null"
			>
				<TooltipTrigger as-child>
					<div
						class="grid-header-cell"
						:class="{
							'opacity-60': columnDrag?.moved === true && columnDrag?.column === column,
						}"
						role="columnheader"
						:style="cellStyleFor(column)"
						:aria-label="column"
						tabindex="0"
						:aria-haspopup="sortable ? 'menu' : undefined"
						:data-selected="columnIsSelected(columnIndex)"
						:data-col="columnIndex"
						@click="onHeaderClick(columnIndex, $event)"
						@pointerdown="startColumnDrag($event, column, columnIndex)"
						@contextmenu="onHeaderContextMenu(column, $event)"
						@keydown="onHeaderKeydown(column, $event)"
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
						<!-- Where the drop lands. The header is a flex row with no gap
						     to draw in, so the rule rides the edge of the column the
						     drop displaces; it is decorative and must never take the
						     press that drives the gesture. -->
						<span
							v-if="dropMarker?.column === column"
							aria-hidden="true"
							class="pointer-events-none absolute inset-y-0 w-0.5 bg-primary"
							:class="dropMarker?.edge === 'trailing' ? 'right-0' : 'left-0'"
						/>
						<!-- The handle sits on the column's trailing edge; a
						     double-click on it re-fits the column to its content,
						     undoing the manual width. -->
						<div
							class="grid-column-resize"
							role="separator"
							aria-orientation="vertical"
							:aria-label="`Resize ${column}`"
							:title="`Resize ${column} — double-click to fit to content`"
							@pointerdown="startColumnResize($event, column)"
							@dblclick.stop="refitColumnWidth(column)"
						/>
					</div>
				</TooltipTrigger>
				<!-- Past the primitive's own `max-w-xs`: a column name is an
				     identifier, and reading one is the entire reason the
				     tooltip exists. -->
				<TooltipContent class="max-w-lg">{{ column }}</TooltipContent>
			</Tooltip>
			</div>
		</div>

		<!-- `RecycleScroller` is the scroller, so the keyboard, focus and ARIA
		     wiring has to land on it rather than on a wrapper that never
		     scrolls. Its width is the pane's width, which is what pins its
		     scrollbar to the pane's right edge. -->
		<RecycleScroller
			ref="recycleRef"
			class="grid-body recall-scroll min-h-0 flex-1 outline-none"
			:style="{ '--grid-content-width': `${totalWidth}px` }"
			:items="rows"
			:key-field="rowKey"
			:item-size="ROW_HEIGHT"
			:buffer="600"
			:disable-transform="true"
			:skip-hover="true"
			role="rowgroup"
			:aria-rowcount="rows.length"
			:aria-colcount="columns.length + 1"
			aria-label="Query results"
			tabindex="0"
			:aria-activedescendant="selection.focus.value ? `cell-${selection.focus.value.row}-${selection.focus.value.col}` : undefined"
			@click="gridFocused = true"
			@focus="gridFocused = true"
			@blur="gridFocused = false"
			@scroll="onBodyScroll"
			@keydown="onKeydown"
		>
				<template #default="{ item, index }">
					<div class="grid-row flex" role="row" :style="rowStyle">
						<Tooltip>
							<TooltipTrigger as-child>
								<div
									class="grid-cell grid-row-number"
									role="cell"
									:style="rowNumberStyle"
									:data-selected="rowIsSelected(index)"
									@click="onRowNumberClick(index, $event)"
								>
									{{ rowNumberLabel(index) }}
								</div>
							</TooltipTrigger>
							<!-- One tooltip per RENDERED row, which is what the virtualiser
							     already bounds: the scroller pools its views, so scrolling
							     re-patches this text rather than mounting anything. It is
							     deliberately not the one shared popper the header menu uses —
							     a menu has to follow a click, whereas a tooltip would have to
							     open before the provider's delay to look right. Both the cell
							     and this quote `rowNumberLabel`, so a recycled view cannot pair
							     one row's cell with another row's number. -->
							<TooltipContent class="max-w-lg">{{ rowNumberLabel(index) }}</TooltipContent>
						</Tooltip>
						<!-- Hover is reported here rather than left to the
						     primitive's own trigger: the tooltip that answers is
						     one parked instance, and this is where the row/col it
						     re-reads comes from. -->
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
							<span
								v-else
								class="truncate"
								:class="cellTypeClass(index, columnIndex)"
							>{{
								cellDisplayValue(
									cellAt(item, columnIndexes[columnIndex] ?? 0),
									columnIndexes[columnIndex] ?? 0,
								)
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
			<!-- One menu for every header. The headers live in a horizontal
			     scroller over a virtualised body, so a per-cell menu would
			     remount with it; this one is parked here, once, and anchored at
			     the pointer or the focused header instead. -->
			<DropdownMenu v-if="sortable" v-model:open="menuOpen">
				<!-- `as-child` hands the anchor element straight to the popper,
				     so the trigger IS the zero-size element. It is `fixed`
				     because the coordinates are viewport-relative while the
				     grid sits offset inside the workspace pane. -->
				<DropdownMenuTrigger as-child>
					<span
						class="pointer-events-none fixed size-0"
						:style="{
							left: `${menuAnchor.x}px`,
							top: `${menuAnchor.y}px`,
						}"
						aria-hidden="true"
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent class="w-48" aria-label="Column actions">
					<DropdownMenuLabel class="truncate">{{ menuColumn }}</DropdownMenuLabel>
					<DropdownMenuItem :disabled="!menuColumn" @select="sortMenuAscending">
						<ArrowUp aria-hidden="true" />
						Sort ascending
					</DropdownMenuItem>
					<DropdownMenuItem :disabled="!menuColumn" @select="sortMenuDescending">
						<ArrowDown aria-hidden="true" />
						Sort descending
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem :disabled="!hasSort" @select="clearSort">
						Clear sort
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<!-- The focused cell's value in full, over the cells to its right.
			     The layer is clipped to the body's viewport and starts right of
			     the pinned gutter, so the box can never reach the header, the
			     status bar, the scrollbar or the gutter; `pointer-events-none`
			     keeps every click and drag reaching the cells underneath. -->
			<div
				v-if="peekStyle"
				class="grid-cell-peek-layer"
				:style="peekLayerStyle"
				aria-hidden="true"
			>
				<div
					class="grid-cell grid-cell-peek"
					:style="peekStyle"
					:data-null="peekIsNull"
				>
					<span class="truncate" :class="peekTypeClass">{{ peekText }}</span>
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
					<!-- The sum is over the SELECTED RECTANGLE only, and
					     non-numeric cells are skipped, never coerced — so the
					     skipped count is stated: a total that quietly dropped
					     a column of digits-as-text would read as arithmetic. -->
					<span
						v-if="selectionSum !== null"
						class="shrink-0 tabular-nums"
					>
						Sum {{ selectionSum.sum.toLocaleString(undefined, { maximumFractionDigits: 6 }) }}
						<template v-if="selectionSum.skipped > 0">
							· <span class="text-muted-foreground">{{ selectionSum.skipped }} skipped</span>
						</template>
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
					<!-- The pager sits ahead of Export and only exists for a
					     table tab: no `page` prop means no result-set paging,
					     and rendering the controls anyway would offer a
					     "Page 1" the workspace cannot act on.

					     There is deliberately no Last button and no jump-to-page
					     input: both need a row count the statement never returned,
					     so they could only ever guess. Next stays enabled on a full
					     page, which is the only evidence a further page exists. -->
					<template v-if="page !== undefined">
						<DropdownMenu>
							<DropdownMenuTrigger as-child>
								<Button
									size="micro"
									variant="ghost"
									class="shrink-0"
									aria-label="Rows per page"
								>
									{{ pageSize }} rows
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent class="w-40" aria-label="Rows per page">
								<DropdownMenuCheckboxItem
									v-for="size in pageSizeOptions"
									:key="size"
									:checked="size === pageSize"
									@select="selectPageSize(size)"
								>
									{{ size }} rows
								</DropdownMenuCheckboxItem>
							</DropdownMenuContent>
						</DropdownMenu>

						<Button
							size="micro"
							variant="ghost"
							class="shrink-0"
							aria-label="First page"
							:disabled="page <= 1"
							@click="goToPage(1)"
						>
							<ChevronsLeft class="size-3" aria-hidden="true" />
						</Button>
						<Button
							size="micro"
							variant="ghost"
							class="shrink-0"
							aria-label="Previous page"
							:disabled="page <= 1"
							@click="goToPage(page - 1)"
						>
							<ChevronLeft class="size-3" aria-hidden="true" />
						</Button>
						<span class="shrink-0 tabular-nums text-muted-foreground">
							Page {{ page }}
						</span>
						<Button
							size="micro"
							variant="ghost"
							class="shrink-0"
							aria-label="Next page"
							:disabled="!hasNextPage"
							@click="goToPage(page + 1)"
						>
							<ChevronRight class="size-3" aria-hidden="true" />
						</Button>
					</template>

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
