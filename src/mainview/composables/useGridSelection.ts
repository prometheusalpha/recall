/**
 * Rectangular cell selection for the result grid.
 *
 * The model is the one DataGrip and dbx use: an *anchor* cell that stays put and
 * a *focus* cell that moves, with the selection being the rectangle they span.
 * That single indirection is what makes Shift+arrow, Shift+click and drag all
 * fall out of the same code instead of three competing selection modes.
 *
 * Selection is addressed by absolute result row and column index, never by
 * anything the virtual scroller renders: a range can extend far past the rows
 * that are currently in the DOM, and copying has to reach those values.
 */

import { computed, ref } from "vue";

export interface CellPosition {
	row: number;
	col: number;
}

/** A normalised rectangle: `start` is the top-left, `end` the bottom-right. */
export interface CellRange {
	startRow: number;
	endRow: number;
	startCol: number;
	endCol: number;
}

/** How a keyboard event wants to move the focus cell. */
export type GridNavigationDirection =
	| "up"
	| "down"
	| "left"
	| "right"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown"
	| "docHome"
	| "docEnd";

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Smallest rectangle containing both cells. */
export function normalizeRange(anchor: CellPosition, focus: CellPosition): CellRange {
	return {
		startRow: Math.min(anchor.row, focus.row),
		endRow: Math.max(anchor.row, focus.row),
		startCol: Math.min(anchor.col, focus.col),
		endCol: Math.max(anchor.col, focus.col),
	};
}

export interface GridSelectionOptions {
	/** Result row count; selection never addresses a row outside it. */
	rowCount: () => number;
	/** Result column count. */
	columnCount: () => number;
	/** How many body rows fit on screen, for PageUp/PageDown. */
	pageSize: () => number;
}

export function useGridSelection(opts: GridSelectionOptions) {
	const anchor = ref<CellPosition | null>(null);
	const focus = ref<CellPosition | null>(null);

	/** The rectangle currently painted, or null when nothing is selected. */
	const range = computed<CellRange | null>(() => {
		if (!anchor.value || !focus.value) return null;
		return normalizeRange(anchor.value, focus.value);
	});

	const selectedCellCount = computed(() => {
		const r = range.value;
		if (!r) return 0;
		return (r.endRow - r.startRow + 1) * (r.endCol - r.startCol + 1);
	});

	/** True when exactly one cell is selected, which is what copy-as-raw needs. */
	const isSingleCell = computed(
		() =>
			range.value !== null &&
			range.value.startRow === range.value.endRow &&
			range.value.startCol === range.value.endCol,
	);

	function isSelected(row: number, col: number): boolean {
		const r = range.value;
		if (!r) return false;
		return (
			row >= r.startRow &&
			row <= r.endRow &&
			col >= r.startCol &&
			col <= r.endCol
		);
	}

	function isActive(row: number, col: number): boolean {
		return focus.value?.row === row && focus.value?.col === col;
	}

	/** A single click: the anchor moves with the focus, so the range collapses. */
	function selectCell(position: CellPosition): void {
		const bounded = {
			row: clamp(position.row, 0, Math.max(0, opts.rowCount() - 1)),
			col: clamp(position.col, 0, Math.max(0, opts.columnCount() - 1)),
		};
		anchor.value = { ...bounded };
		focus.value = { ...bounded };
	}

	/**
	 * Shift+click and Shift+arrow: the anchor holds still and the focus moves,
	 * so repeated Shift+arrow calls keep widening from the same origin.
	 */
	function extendSelectionTo(position: CellPosition): void {
		if (!anchor.value) {
			selectCell(position);
			return;
		}
		focus.value = {
			row: clamp(position.row, 0, Math.max(0, opts.rowCount() - 1)),
			col: clamp(position.col, 0, Math.max(0, opts.columnCount() - 1)),
		};
	}

	/** The whole result, as one rectangle. */
	function selectAll(): void {
		const rows = opts.rowCount();
		const cols = opts.columnCount();
		if (rows === 0 || cols === 0) return;
		anchor.value = { row: 0, col: 0 };
		focus.value = { row: rows - 1, col: cols - 1 };
	}

	function clear(): void {
		anchor.value = null;
		focus.value = null;
	}

	/**
	 * Where the focus cell should land for a navigation key.
	 *
	 * The result is already clamped to the grid: callers scroll the viewport to
	 * it, and an unclamped -1 would produce a negative scrollTop that the
	 * browser silently clamps back, moving the caret somewhere else again.
	 */
	function nextPosition(
		direction: GridNavigationDirection,
	): CellPosition | null {
		const current = focus.value;
		const rows = opts.rowCount();
		const cols = opts.columnCount();
		if (rows === 0 || cols === 0) return null;

		// Any navigation with no selection yet starts at the top-left cell.
		if (!current) {
			const origin: Record<GridNavigationDirection, CellPosition> = {
				up: { row: rows - 1, col: 0 },
				down: { row: 0, col: 0 },
				left: { row: 0, col: cols - 1 },
				right: { row: 0, col: 0 },
				home: { row: 0, col: 0 },
				end: { row: 0, col: cols - 1 },
				pageUp: { row: 0, col: 0 },
				pageDown: { row: 0, col: 0 },
				docHome: { row: 0, col: 0 },
				docEnd: { row: rows - 1, col: cols - 1 },
			};
			return origin[direction];
		}

		const page = Math.max(1, opts.pageSize());
		const lastRow = rows - 1;
		const lastCol = cols - 1;
		const target: CellPosition = {
			up: { row: current.row - 1, col: current.col },
			down: { row: current.row + 1, col: current.col },
			left: { row: current.row, col: current.col - 1 },
			right: { row: current.row, col: current.col + 1 },
			// Home/End work on the current row; docHome/docEnd jump to corners.
			home: { row: current.row, col: 0 },
			end: { row: current.row, col: lastCol },
			pageUp: { row: current.row - page, col: current.col },
			pageDown: { row: current.row + page, col: current.col },
			docHome: { row: 0, col: 0 },
			docEnd: { row: lastRow, col: lastCol },
		}[direction];

		return {
			row: clamp(target.row, 0, lastRow),
			col: clamp(target.col, 0, lastCol),
		};
	}

	return {
		anchor,
		focus,
		range,
		selectedCellCount,
		isSingleCell,
		isSelected,
		isActive,
		selectCell,
		extendSelectionTo,
		selectAll,
		clear,
		nextPosition,
	};
}