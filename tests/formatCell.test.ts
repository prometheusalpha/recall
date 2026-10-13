import { describe, expect, test } from "bun:test";
import { formatCellValue } from "../src/mainview/lib/formatCell";

describe("formatCellValue absolute instants", () => {
	// The driver reads a timestamptz column as Postgres text when it can cast it;
	// the microsecond digits must survive the re-zone to Asia/Bangkok.
	test("keeps six fractional digits from Postgres text", () => {
		expect(
			formatCellValue(
				"2026-01-01T06:15:00.123456-05:45",
				"timestamp with time zone",
			),
		).toBe("2026-01-01 19:00:00.123456+07");
	});

	test("keeps three fractional digits from the millisecond Date fallback", () => {
		expect(formatCellValue("2026-01-01T12:00:00.123Z", "timestamptz")).toBe(
			"2026-01-01 19:00:00.123+07",
		);
	});

	test("accepts an offset with a colon and no fraction", () => {
		expect(formatCellValue("2026-01-01T19:00:00+07:00", "timestamptz")).toBe(
			"2026-01-01 19:00:00+07",
		);
	});

	test("keeps a wall clock untouched", () => {
		expect(
			formatCellValue("2026-01-01 12:00:00.123456", "timestamp without time zone"),
		).toBe("2026-01-01 12:00:00.123456");
	});

	test("leaves infinity untouched", () => {
		expect(formatCellValue("infinity", "timestamptz")).toBe("infinity");
		expect(formatCellValue("-infinity", "timestamptz")).toBe("-infinity");
	});

	test("leaves Postgres date text untouched", () => {
		expect(formatCellValue("2026-01-01", "date")).toBe("2026-01-01");
	});

	test("leaves an ISO string of a non-instant type untouched", () => {
		expect(
			formatCellValue("2026-01-01T06:15:00.123456-05:45", "text"),
		).toBe("2026-01-01T06:15:00.123456-05:45");
	});

	test("does not remap a year below 100 into the 20th century", () => {
		const year = "0099";
		const rendered = formatCellValue(`${year}-01-01T00:00:00Z`, "timestamptz");
		const renderedYear = Number(rendered.slice(0, rendered.indexOf("-")));
		expect(renderedYear).toBe(Number(year));
	});
});

describe("formatCellValue non-strings", () => {
	test("stringifies primitives and empties nullish values", () => {
		expect(formatCellValue(42)).toBe("42");
		expect(formatCellValue(true)).toBe("true");
		expect(formatCellValue(null)).toBe("");
		expect(formatCellValue(undefined)).toBe("");
	});

	test("JSON-encodes nested values", () => {
		expect(formatCellValue({ a: 1, b: [2, "x"] })).toBe('{"a":1,"b":[2,"x"]}');
	});
});
