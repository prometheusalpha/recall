import { describe, expect, test } from "bun:test";
import {
	fullColumnOrder,
	mergeVisibleOrder,
	moveItem,
} from "../src/mainview/lib/columnOrder";

describe("fullColumnOrder", () => {
	test("an empty overlay is the result's own order", () => {
		expect(fullColumnOrder([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
	});

	test("drops stale names and appends unseen ones", () => {
		expect(fullColumnOrder(["c", "gone", "a"], ["a", "b", "c"])).toEqual([
			"c",
			"a",
			"b",
		]);
	});
});

describe("mergeVisibleOrder", () => {
	test("hidden columns keep their slots", () => {
		// b is hidden; the header swapped a and c.
		expect(mergeVisibleOrder(["a", "b", "c", "d"], ["c", "a", "d"])).toEqual([
			"c",
			"b",
			"a",
			"d",
		]);
	});
});

describe("moveItem", () => {
	test("moves forwards and backwards", () => {
		expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
		expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
	});

	test("out-of-range indexes leave the list alone", () => {
		const list = ["a", "b"];
		expect(moveItem(list, 0, 5)).toBe(list);
	});
});
