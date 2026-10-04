/**
 * Auto-width arithmetic for the result grid columns.
 *
 * The grid renders in a monospace face, so widths can be derived from a single
 * measured advance width instead of per-cell DOM measurement. Every helper here
 * is pure (or lazily created offscreen) so it can be called during render
 * without touching Vue state.
 */

/** Monospace advance width in px, used when no canvas measurement is available. */
export const GRID_CHAR_WIDTH = 8;
/** Cell horizontal padding (0.5rem each side) plus the 1px cell border. */
export const GRID_CELL_PADDING = 17;
/** Narrowest a column may auto-size to. */
export const GRID_MIN_AUTO_WIDTH = 60;
/** Widest a column may auto-size to. */
export const GRID_MAX_AUTO_WIDTH = 400;
/** How many rows are sampled per column. */
export const GRID_SAMPLE_ROWS = 50;

/**
 * Characters past this length are truncated before measuring: one
 * 10 000-character cell must not blow the column out to the max width.
 */
const GRID_VALUE_TEXT_LIMIT = 60;

/** Long run of a repeated character; long enough that sub-pixel advances average out. */
const CHAR_WIDTH_PROBE_LENGTH = 100;

/** Code points above ASCII `~` (CJK, full-width forms, emoji) render about twice as wide. */
const WIDE_CODE_POINT_THRESHOLD = 0x7e;

/**
 * Estimated pixel width of `text` in a monospace face: full-width code points
 * count as two units, everything else as one.
 */
export function estimateTextWidth(text: string, charWidth: number = GRID_CHAR_WIDTH): number {
	let units = 0;
	for (const ch of text) {
		const codePoint = ch.codePointAt(0) ?? 0;
		units += codePoint > WIDE_CODE_POINT_THRESHOLD ? 2 : 1;
	}
	return units * charWidth;
}

/** JSON-safe driver values, normalised to the text a cell shows. */
function formatCellValue(value: unknown): string {
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

/**
 * Head-and-tail sample of one column, rendered to the strings the cells show.
 * Sampling both ends lets a column grow when a later page holds wider values,
 * and a short/malformed row reads as empty rather than throwing.
 */
export function sampleColumnValues(
	rows: unknown[][],
	index: number,
	limit: number = GRID_SAMPLE_ROWS,
): string[] {
	const total = Math.max(1, Math.floor(limit));
	if (rows.length <= total) {
		return rows.map((row) => formatCellValue(cellAt(row, index)));
	}
	const headCount = Math.ceil(total / 2);
	const tailCount = total - headCount;
	const values: string[] = [];
	for (let offset = 0; offset < headCount; offset++) {
		values.push(formatCellValue(cellAt(rows[offset], index)));
	}
	for (let offset = rows.length - tailCount; offset < rows.length; offset++) {
		values.push(formatCellValue(cellAt(rows[offset], index)));
	}
	return values;
}

/** Guarded read so a malformed row yields `undefined` instead of a crash. */
function cellAt(row: unknown[] | undefined, index: number): unknown {
	return row?.[index];
}

/** Offscreen canvas created on first measurement, reused afterwards. */
let measurementCanvas: HTMLCanvasElement | null = null;
let measurementContext: CanvasRenderingContext2D | null = null;

function getMeasurementContext(): CanvasRenderingContext2D | null {
	if (measurementContext) return measurementContext;
	if (typeof document === "undefined") return null;
	try {
		measurementCanvas ??= document.createElement("canvas");
		measurementContext = measurementCanvas.getContext("2d");
	} catch {
		measurementContext = null;
	}
	return measurementContext;
}

/**
 * Real advance width of the grid's monospace face, measured once per session.
 * Falls back to {@link GRID_CHAR_WIDTH} outside the DOM or when the canvas is
 * unavailable (tests, main process, blocked context creation).
 */
export function measureCharWidth(font: string): number {
	const context = getMeasurementContext();
	if (!context) return GRID_CHAR_WIDTH;
	try {
		context.font = font;
		const probe = "0".repeat(CHAR_WIDTH_PROBE_LENGTH);
		const width = context.measureText(probe).width;
		if (!Number.isFinite(width) || width <= 0) return GRID_CHAR_WIDTH;
		return width / CHAR_WIDTH_PROBE_LENGTH;
	} catch {
		return GRID_CHAR_WIDTH;
	}
}

/**
 * Final column width: the wider of the header and its sampled values, capped at
 * `max` and floored at `min` so an empty column still stays clickable.
 */
export function autoColumnWidth(args: {
	header: string;
	values: string[];
	charWidth: number;
	min?: number;
	max?: number;
}): number {
	const min = args.min ?? GRID_MIN_AUTO_WIDTH;
	const max = args.max ?? GRID_MAX_AUTO_WIDTH;
	const charWidth = args.charWidth > 0 ? args.charWidth : GRID_CHAR_WIDTH;

	const headerWidth = estimateTextWidth(args.header, charWidth) + GRID_CELL_PADDING;
	let valueWidth = GRID_CELL_PADDING;
	for (const value of args.values) {
		const width =
			estimateTextWidth(value.slice(0, GRID_VALUE_TEXT_LIMIT), charWidth) +
			GRID_CELL_PADDING;
		if (width > valueWidth) valueWidth = width;
	}

	return Math.max(min, Math.min(max, Math.round(Math.max(headerWidth, valueWidth))));
}