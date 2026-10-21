import { describe, expect, test } from "bun:test";
import {
	columnOffsets,
	columnWindow,
	includeColumn,
} from "../src/mainview/lib/columnWindow";

// 50 columns of 100px behind a 56px sticky gutter, in an 800px viewport.
const offsets = columnOffsets(Array.from({ length: 50 }, () => 100));
const base = { offsets, viewportWidth: 800, gutter: 56, buffer: 0 };

describe("columnWindow", () => {
	test("renders only the columns the viewport shows", () => {
		// 744px of columns visible: 0..7 (the eighth is cut at 744).
		expect(columnWindow({ ...base, scrollLeft: 0 })).toEqual({
			start: 0,
			end: 8,
			before: 0,
		});
	});

	test("a column partly under the gutter still renders", () => {
		// scrollLeft 150: column 1 (100..200) is half hidden under the pin.
		const w = columnWindow({ ...base, scrollLeft: 150 });
		expect(w.start).toBe(1);
		expect(w.before).toBe(100);
		// last visible coordinate is 150 + 744 = 894, inside column 8.
		expect(w.end).toBe(9);
	});

	test("buffer widens both sides and clamps at the edges", () => {
		const w = columnWindow({ ...base, scrollLeft: 1000, buffer: 300 });
		expect(w).toEqual({ start: 7, end: 21, before: 700 });
		const end = columnWindow({ ...base, scrollLeft: 4256, buffer: 300 });
		expect(end.end).toBe(50);
	});

	test("an unmeasured viewport still renders one column", () => {
		const w = columnWindow({ ...base, viewportWidth: 0, scrollLeft: 0 });
		expect(w).toEqual({ start: 0, end: 1, before: 0 });
	});

	test("no columns renders nothing", () => {
		expect(columnWindow({ ...base, offsets: [0], scrollLeft: 0 })).toEqual({
			start: 0,
			end: 0,
			before: 0,
		});
	});

	test("uneven widths are found by their offsets", () => {
		const uneven = columnOffsets([40, 900, 40, 40]);
		const w = columnWindow({ ...base, offsets: uneven, scrollLeft: 500 });
		expect(w).toEqual({ start: 1, end: 4, before: 40 });
	});
});

describe("includeColumn", () => {
	const window = { start: 10, end: 18, before: 1000 };

	test("leaves a window that already covers the column", () => {
		expect(includeColumn(window, 12, offsets)).toBe(window);
	});

	test("grows left to an editor scrolled off the left", () => {
		expect(includeColumn(window, 3, offsets)).toEqual({
			start: 3,
			end: 18,
			before: 300,
		});
	});

	test("grows right to an editor scrolled off the right", () => {
		expect(includeColumn(window, 30, offsets)).toEqual({
			start: 10,
			end: 31,
			before: 1000,
		});
	});
});
