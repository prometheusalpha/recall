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
import { toast } from "../../composables/useToast";
import { errorMessage, rpc } from "../../lib/rpc";
import {
	useGridSelection,
	type GridNavigationDirection,
} from "../../composables/useGridSelection";
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
		pageSize: 1000,
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

/**
 * The element that actually scrolls.
 *
 * `RecycleScroller` is the scroller: it carries `overflow-y: auto` itself, so
 * `grid-body` around it never overflows and never scrolls. The rows hang off
 * the scroller's item wrapper, which is pinned to `width: 100%` of the
 * viewport — without the width override below, wide columns would spill out of
 * that wrapper instead of giving the scroller a horizontal range, and the grid
 * would lose horizontal scrolling altogether.
 *
 * Reading it off the component's root keeps `scrollTop`/`scrollLeft` and the
 * header pairing pointed at the one element that has a range to scroll.
 */
function scrollerNode(): HTMLElement | null {
	return (recycleRef.value?.$el as HTMLElement | undefined) ?? null;
}

/**
 * Keeps the header aligned with the body.
 *
 * Assignment is guarded because setting `scrollLeft` fires a scroll event on
 * the header too: without the equality check the two would push each other
 * forever. The guard is what makes the pairing one-way per gesture rather than
 * a feedback loop.
 *
 * The value is clamped to the header's own range. The two scrollers are sized
 * to travel the same distance, but a layout that lands between a gutter
 * measurement and a scroll can leave one of them shorter, and an
 * unclamped offset is how the two would start to disagree.
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
 * travels further right than the header does and the pairing above clamps the
 * header short of it — leaving the last column's header sitting to the left of
 * its column. Widening the header's content by the same gutter gives it the
 * body's horizontal range instead of its own narrower one.
 *
 * Overlay scrollbars report no gutter, so this settles at 0 on macOS and does
 * nothing; on a platform with classic scrollbars it is the whole difference
 * between aligned and not at the far right.
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
 * **Presence of the key is the whole contract**: a key here means "the user
 * sized this", and its value is the width to use — there is no separate
 * user-sized flag, because the only two things that write here are a drag and
 * the re-fit double-click. An absent key means the column auto-fits.
 *
 * Keying by name rather than index is what lets a width survive hiding a
 * different column, reordering, and re-running the statement.
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
 * Fitted width per visible column, keyed by name like `columnWidths`.
 *
 * Sampling reads the RESULT column index, never the visible one: once a column
 * is hidden the visible indexes slide left, and measuring through them would
 * quietly size each remaining column to its neighbour's values.
 *
 * Dependencies are `props.result`, `columns`, `columnIndexes` and `charWidth`,
 * and nothing else — the sample is the expensive half, so it must not re-run on
 * a scroll or a selection change. `charWidth` is a dependency despite reading
 * like a constant: without it the post-`fonts.ready` re-measure would move the
 * number and no width would follow.
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
			values: sampleColumnValues(result.rows, resultIndex),
			charWidth: charWidth.value,
		});
	});
	return fitted;
});

/** The caller's width, used when a column has neither an override nor a fit. */
const columnPixelWidth = computed(() => props.columnWidth);

/**
 * Width of one rendered column.
 *
 * Precedence is override → auto → the `columnWidth` prop:
 *  - a dragged column keeps its dragged width, so the fit cannot snap it back
 *    when the result changes;
 *  - an untouched column re-fits on every new result, hiding or un-hiding a
 *    column, or font measurement;
 *  - the prop is the last resort, for a column with nothing to measure.
 *
 * Only the override is floored at {@link MIN_COLUMN_WIDTH}. An auto width is
 * left alone, so it can go all the way down to `GRID_MIN_AUTO_WIDTH` — the
 * 120px drag floor is a hand-sized minimum, and applying it to a fitted width
 * would put back exactly the empty-looking narrow columns the auto fit exists
 * to remove.
 */
function widthFor(column: string): number {
	const dragged = columnWidths.value[column];
	if (dragged !== undefined) return Math.max(MIN_COLUMN_WIDTH, dragged);
	return autoColumnWidths.value[column] ?? columnPixelWidth.value;
}

/**
 * Re-measures the character width against the font a rendered cell is
 * actually painted in, and re-fits anything the user has not sized.
 *
 * `getComputedStyle` on a live `.grid-cell` rather than a hardcoded shorthand:
 * the mono face is a CSS variable, so its size and family can change with the
 * theme, and a literal would size every column against a face the grid does
 * not use. The cell is read for its resolved values only — nothing is
 * mutated.
 *
 * Does nothing when no cell is rendered yet (an empty result, or a hidden
 * grid), leaving the library default in place until there is one.
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
 * content.
 *
 * "Reset to default" would be the wrong name now that there is a default to
 * return TO: the width this restores is the fitted one, which changes with
 * every result. Deleting the key is the whole operation — `widthFor` already
 * falls through to `autoColumnWidths` — and it is the only thing that clears
 * the user-sized marker, which is why it cannot be faked by writing a width.
 *
 * Guarded on absence so a double-click on an already-fitted column does not
 * churn the map, and so a fitted-but-unrendered column is not treated as an
 * override.
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

/**
 * Whether the gutter cell for this row is painted as selected.
 *
 * Only when the rectangle genuinely covers the row end to end. Testing the
 * last column instead — which is what this did — made a click on any single
 * cell there light the whole gutter, so one selected cell in the rightmost
 * column read as "the whole row is selected". The gutter is the row's own
 * affordance, so it may only claim a selection that includes every cell.
 *
 * This still lights for everything that really does select whole rows: the
 * gutter click and its shift-click both run to column 0 and back to the last
 * one, and select-all spans the full rectangle.
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
 * moved to the header's context menu, because a click that re-runs the
 * statement is one the user cannot take back — choosing a column and ordering
 * the result are separate intentions and now have separate gestures.
 *
 * A drag that crossed the reorder threshold ends with a `click` on the cell it
 * started from, and that click has to be discarded: the user asked to move the
 * column, and re-selecting the one that moved out from under the pointer is
 * not what they asked for. The flag is cleared on the next press, so a real
 * click is never lost.
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
		if (left < container.scrollLeft) {
			container.scrollLeft = left;
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

/** Body text: a NULL cell shows a dim `NULL` marker instead of reading as blank. Editing and copy keep using the raw `formatValue`. */
function cellDisplayValue(value: unknown): string {
	if (isNullValue(value)) return "NULL";
	return formatValue(value);
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
			<Button variant="outline" size="sm" :disabled="busy" @click="emit('reconnect')">
				<RefreshCw aria-hidden="true" />
				Reconnect
			</Button>
		</div>

		<template v-else>
			<ResultFilterBar
				:where="where"
				:order-by="orderBy"
				:sortable="filterable"
				:busy="busy"
				:columns="result.columns"
				:visible-columns="columns"
				@update:where="(value) => emit('update:where', value)"
				@update:order-by="(value) => emit('update:orderBy', value)"
				@update:visible-columns="onVisibleColumnsChange"
				@apply="emit('applyFilter')"
				@rerun="emit('rerun')"
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
				<div
					class="grid-header-cell grid-row-number"
					role="columnheader"
					:style="rowNumberStyle"
					aria-label="Row number"
				>
					#
				</div>
				<!-- `tabindex`/`aria-haspopup` because a sort is now a menu:
				     a pointer is not the only way to open it. `aria-label`
				     names the column for a screen reader, which would
				     otherwise read the truncated text. -->
				<div
					v-for="(column, columnIndex) in columns"
					:key="column"
					class="grid-header-cell"
					:class="{
						'opacity-60': columnDrag?.moved === true && columnDrag?.column === column,
					}"
					role="columnheader"
					:style="cellStyleFor(column)"
					:title="column"
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
			:buffer="240"
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
			@scroll="syncHeaderScroll"
			@keydown="onKeydown"
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
							<!-- 1-based, and global across pages: page 2 of a
							     1000-row page starts at 1001, not 1. A user
							     comparing two pages reads these as positions in
							     one result set, so numbering per page would
							     silently point them at the wrong rows. -->
							{{ index + 1 + pageOffset }}
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
								cellDisplayValue(
									cellAt(item, columnIndexes[columnIndex] ?? 0),
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
					<!-- The pager sits ahead of Export and only exists for a
					     table tab: no `page` prop means no result-set paging,
					     and rendering the controls anyway would offer a
					     "Page 1" the workspace cannot act on.

					     There is deliberately no Last button and no
					     jump-to-page input. Both need a row count the
					     statement never returned — the query is limited and
					     the total is unknown — so they could only ever
					     guess. Next stays enabled on a full page, which is
					     the only evidence a further page exists. -->
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
