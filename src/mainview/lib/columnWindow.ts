/**
 * Horizontal windowing for the result grid: which columns a row renders.
 *
 * A row used to render every column, so a wide result painted every cell of
 * every pooled row on each scroll frame. Only the columns overlapping the
 * viewport (plus a buffer) are rendered; one spacer stands in for the columns
 * scrolled off to the left. The row keeps its full width, so the scroll range
 * and the right side need no spacer.
 *
 * Pure so it can be tested without a DOM; `useColumnWindow` owns the state.
 */

/** Columns `[start, end)` are rendered; `before` is the spacer left of them. */
export interface ColumnWindow {
	start: number;
	end: number;
	before: number;
}

/** `offsets[i]` is column i's left edge; one extra entry holds the total. */
export function columnOffsets(widths: readonly number[]): number[] {
	const offsets = [0];
	let total = 0;
	for (const width of widths) {
		total += width;
		offsets.push(total);
	}
	return offsets;
}

export interface ColumnWindowInput {
	offsets: readonly number[];
	scrollLeft: number;
	viewportWidth: number;
	/** The sticky gutter covers this much of the viewport's left edge. */
	gutter: number;
	/** Extra px rendered on each side, so a short scroll needs no re-render. */
	buffer: number;
}

/**
 * Offsets are in column coordinates (0 = right edge of the gutter). The gutter
 * is sticky, so the first visible column coordinate is `scrollLeft` itself and
 * the last is `scrollLeft + viewportWidth - gutter`.
 */
export function columnWindow(input: ColumnWindowInput): ColumnWindow {
	const { offsets } = input;
	const count = offsets.length - 1;
	if (count <= 0) return { start: 0, end: 0, before: 0 };
	const from = input.scrollLeft - input.buffer;
	const to =
		input.scrollLeft + Math.max(0, input.viewportWidth - input.gutter) + input.buffer;

	// First column whose right edge is past `from`.
	let low = 0;
	let high = count - 1;
	while (low < high) {
		const mid = (low + high) >> 1;
		if ((offsets[mid + 1] ?? 0) <= from) low = mid + 1;
		else high = mid;
	}
	const start = low;
	let end = start + 1;
	while (end < count && (offsets[end] ?? 0) < to) end++;
	return { start, end, before: offsets[start] ?? 0 };
}

/** Grows a window to also cover `col`, e.g. an open editor that must stay mounted. */
export function includeColumn(
	window: ColumnWindow,
	col: number,
	offsets: readonly number[],
): ColumnWindow {
	if (col >= window.start && col < window.end) return window;
	const start = Math.min(window.start, col);
	return { start, end: Math.max(window.end, col + 1), before: offsets[start] ?? 0 };
}

export function sameWindow(a: ColumnWindow, b: ColumnWindow): boolean {
	return a.start === b.start && a.end === b.end && a.before === b.before;
}
