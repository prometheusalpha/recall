import { describe, expect, test } from "bun:test";
import {
	clauseConnectors,
	clauseFieldSuggestions,
	clauseInsertText,
	clausePick,
	clauseRole,
	clauseTarget,
	type ClauseKind,
	type ClauseSuggestionRole,
} from "../src/mainview/lib/clauseSuggestion";

/** Postgres writes `"` around an identifier it cannot take bare. */
const POSTGRES_QUOTE = '"';

describe("clauseTarget", () => {
	test("reads the identifier run the caret sits in", () => {
		const target = clauseTarget("where", "id = na", 7, 7, POSTGRES_QUOTE);
		expect(target.token).toBe("na");
		expect(target.from).toBe(5);
		expect(target.to).toBe(7);
	});

	test("extends the run past the caret, so a pick replaces the whole name", () => {
		const target = clauseTarget("where", "id = name", 7, 7, POSTGRES_QUOTE);
		expect(target.token).toBe("na");
		expect(target.from).toBe(5);
		expect(target.to).toBe(9);
	});

	test("ends the run at the operator that precedes it", () => {
		const target = clauseTarget("where", "a=na", 4, 4, POSTGRES_QUOTE);
		expect(target.token).toBe("na");
		expect(target.from).toBe(2);
	});

	test("keeps dashes inside an ORDER BY name", () => {
		const target = clauseTarget("orderBy", "created-at na", 13, 13);
		expect(target.token).toBe("na");
		expect(target.from).toBe(11);
	});

	test("reports a caret inside a string literal, where nothing is suggested", () => {
		const target = clauseTarget("where", "name = 'Ali", 11, 11, POSTGRES_QUOTE);
		expect(target.insideString).toBe(true);
		expect(target.token).toBe("");
	});

	test("reads only the content of the quoted identifier under the caret", () => {
		const target = clauseTarget("where", 'name = "OrderId"', 11, 11, POSTGRES_QUOTE);
		expect(target.quotedIdentifier).toBe(true);
		expect(target.token).toBe("Ord");
		// The closing quote is inside the value, so the name is replaced alone
		// and the quotes the user typed survive.
		expect(target.from).toBe(8);
		expect(target.to).toBe(15);
	});

	test("replaces the selection when there is one", () => {
		const target = clauseTarget("where", "id = old", 5, 8, POSTGRES_QUOTE);
		expect(target.token).toBe("old");
		expect(target.from).toBe(5);
		expect(target.to).toBe(8);
	});

	test("leaves ORDER BY unquoted: no dialect quote is read there", () => {
		const target = clauseTarget("orderBy", '"Ord', 4, 4, POSTGRES_QUOTE);
		expect(target.quotedIdentifier).toBe(false);
		expect(target.token).toBe('"Ord');
	});
});

describe("clauseRole", () => {
	// The caret is always at the end of the value, which is where typing puts it.
	const cases: Array<[string, string, ClauseSuggestionRole]> = [
		["a field is asked for by an empty fragment", "", "field"],
		["a field follows a connector", "status = 'active' AND ", "field"],
		["a field follows a negation", "id = 1 AND NOT ", "field"],
		["a field follows an operator", "id = a", "field"],
		["a field follows a quoted identifier", 'name = "OrderId" AND ', "field"],
		["a connector follows a complete expression", "owner_id = 1 a", "connector"],
		["a connector follows a finished literal", "id = 1 ", "connector"],
		["a value operand has nothing to suggest", "name = 'Alice a", "none"],
		["IS introduces a value", "deleted_at IS a", "none"],
		["IS NOT introduces a value", "deleted_at IS NOT o", "none"],
		["LIKE introduces a value", "name LIKE o", "none"],
		["IN introduces a value", "id IN a", "none"],
		["BETWEEN introduces a value", "score BETWEEN o", "none"],
	];

	for (const [name, value, expected] of cases) {
		test(name, () => {
			const target = clauseTarget("where", value, value.length, value.length, POSTGRES_QUOTE);
			expect(clauseRole("where", target)).toBe(expected);
		});
	}

	test("ORDER BY is a field list: it has no connectors", () => {
		const value = "name AND a";
		const target = clauseTarget("orderBy", value, value.length, value.length);
		expect(clauseRole("orderBy", target)).toBe("field");
	});

	test("reads ` as the identifier quote on MySQL, so `\"` opens a string", () => {
		const value = 'name = "Ali';
		const target = clauseTarget("where", value, value.length, value.length, "`");
		expect(clauseRole("where", target)).toBe("none");
	});
});

describe("clauseConnectors", () => {
	test("offers both connectors once nothing of one is typed", () => {
		expect(clauseConnectors("")).toEqual(["AND", "OR"]);
	});

	test("narrows by the typed prefix, case-insensitively", () => {
		expect(clauseConnectors("a")).toEqual(["AND"]);
		expect(clauseConnectors("o")).toEqual(["OR"]);
		expect(clauseConnectors("aN")).toEqual(["AND"]);
	});

	test("drops the connector that is already fully typed", () => {
		expect(clauseConnectors("and")).toEqual([]);
		expect(clauseConnectors("OR")).toEqual([]);
	});

	test("offers nothing for a token neither connector starts with", () => {
		expect(clauseConnectors("x")).toEqual([]);
	});
});

describe("clauseFieldSuggestions", () => {
	test("ranks a prefix match, shortest name first", () => {
		const rows = clauseFieldSuggestions({
			columns: ["namespace", "name", "id"],
			token: "na",
			quotedIdentifier: false,
		});
		expect(rows.map((row) => row.column)).toEqual(["name", "namespace"]);
	});

	test("keeps fuzzy matches and drops what the token cannot reach", () => {
		const rows = clauseFieldSuggestions({
			columns: ["customer_id", "order_id", "category_id"],
			token: "cid",
			quotedIdentifier: false,
		});
		expect(rows.map((row) => row.column)).toEqual(["customer_id", "category_id"]);
	});

	test("falls back to the full list when nothing matches", () => {
		const rows = clauseFieldSuggestions({
			columns: ["alpha", "beta"],
			token: "zzz",
			quotedIdentifier: false,
		});
		expect(rows.map((row) => row.column)).toEqual(["alpha", "beta"]);
	});

	test("lists every column, in order, for an empty token", () => {
		const rows = clauseFieldSuggestions({
			columns: ["beta", "alpha"],
			token: "",
			quotedIdentifier: false,
		});
		expect(rows.map((row) => row.column)).toEqual(["beta", "alpha"]);
	});

	test("ends the list once the token IS a column: the name is complete", () => {
		const rows = clauseFieldSuggestions({
			columns: ["id", "name"],
			token: "ID",
			quotedIdentifier: false,
		});
		expect(rows).toEqual([]);
	});

	test("inserts the bare name inside quotes the user already typed", () => {
		const rows = clauseFieldSuggestions({
			columns: ["OrderId"],
			token: "Ord",
			quotedIdentifier: true,
			dbType: "postgres",
		});
		expect(rows).toEqual([{ column: "OrderId", insertText: "OrderId" }]);
	});

	test("quotes the insert when the dialect cannot take the name bare", () => {
		for (const [dbType, column, insertText] of [
			["postgres", "order_id", "order_id"],
			["postgres", "OrderId", '"OrderId"'],
			["mysql", "OrderId", "OrderId"],
		] as const) {
			const rows = clauseFieldSuggestions({
				columns: [column],
				token: "",
				quotedIdentifier: false,
				dbType,
			});
			expect(rows).toEqual([{ column, insertText }]);
		}
	});
});

describe("clauseInsertText", () => {
	test("leaves a name the dialect resolves on its own bare", () => {
		expect(clauseInsertText("order_id", "postgres")).toBe("order_id");
		expect(clauseInsertText("OrderId", "mysql")).toBe("OrderId");
	});

	test("quotes a bare name that would parse as a keyword", () => {
		expect(clauseInsertText("order", "postgres")).toBe('"order"');
		expect(clauseInsertText("order", "mysql")).toBe("`order`");
	});

	test("quotes what the dialect cannot read bare, doubling its own quote", () => {
		expect(clauseInsertText("OrderId", "postgres")).toBe('"OrderId"');
		expect(clauseInsertText("has space", "postgres")).toBe('"has space"');
		expect(clauseInsertText('has"quote', "postgres")).toBe('"has""quote"');
		expect(clauseInsertText("has space", "mysql")).toBe("`has space`");
		expect(clauseInsertText("weird`name", "mysql")).toBe("`weird``name`");
	});

	test("adds nothing when the caller did not say which dialect this is", () => {
		expect(clauseInsertText("OrderId")).toBe("OrderId");
	});
});

describe("clausePick", () => {
	test("writes the space the operator will follow when the tail is empty", () => {
		expect(
			clausePick({
				kind: "where",
				value: "id = ",
				caret: 5,
				insertText: "name",
			}),
		).toEqual({ value: "id = name ", caret: 10 });
	});

	test("replaces the name being typed and keeps the text around it", () => {
		expect(
			clausePick({
				kind: "where",
				value: "id = na AND active",
				caret: 7,
				insertText: "name",
			}),
		).toEqual({ value: "id = name AND active", caret: 9 });
	});

	test("keys off the caret, not the end of the fragment", () => {
		expect(
			clausePick({
				kind: "where",
				value: "status = cus AND enabled = 1",
				caret: 12,
				insertText: "customer_id",
			}),
		).toEqual({ value: "status = customer_id AND enabled = 1", caret: 20 });
	});

	test("keeps the quotes the user typed around a quoted identifier", () => {
		expect(
			clausePick({
				kind: "where",
				value: 'name = "Ord"',
				caret: 11,
				insertText: "OrderId",
				identifierQuote: POSTGRES_QUOTE,
			}),
		).toEqual({ value: 'name = "OrderId"', caret: 15 });
	});

	test("writes over a selection instead of appending to it", () => {
		expect(
			clausePick({
				kind: "where",
				value: "id = old",
				caret: 5,
				selectionEnd: 8,
				insertText: "name",
			}),
		).toEqual({ value: "id = name", caret: 9 });
	});

	test("adds no space when the pick lands inside a literal", () => {
		expect(
			clausePick({
				kind: "where",
				value: "name = 'Ali",
				caret: 11,
				insertText: "Alice",
				identifierQuote: POSTGRES_QUOTE,
			}),
		).toEqual({ value: "name = 'AliAlice", caret: 16 });
	});

	test("replaces the ORDER BY name being typed", () => {
		const kind: ClauseKind = "orderBy";
		expect(
			clausePick({
				kind,
				value: "name na",
				caret: 7,
				insertText: "namespace",
			}),
		).toEqual({ value: "name namespace", caret: 14 });
	});
});
