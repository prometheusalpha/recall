/**
 * Schema-aware completions for the SQL editor: table names and column names.
 *
 * The clause decision — "is the cursor in a position that wants tables or
 * columns?" — comes from a line-scoped regex scan of the text before the
 * cursor, not from a parser. A full SQL parser would be the only thing that
 * could be wrong here, and this popup is a hint, not a validator: it must never
 * cost more than a keystroke and must never throw on SQL it does not understand.
 *
 * Everything here is CodeMirror-free at runtime — the caller injects the lazily
 * loaded `@codemirror/autocomplete` types and reads the schema through
 * callbacks — so this module stays in the entry bundle.
 */
import type { ColumnInfo } from "../../../shared/types";
import type {
	Completion,
	CompletionContext,
	CompletionResult,
	CompletionSource,
} from "@codemirror/autocomplete";

export type SchemaCompletionKind = "table" | "column";

export interface SchemaCompletionContext {
	/** Table names available in the active tab's schema. */
	tables: readonly string[];
	/** Columns keyed by table name; the active tab's table always resolves. */
	columnsFor: (table: string) => readonly ColumnInfo[];
	/**
	 * The tab's own table, whose columns are offered in every column clause even
	 * when the statement has not named it yet (`SELECT `).
	 */
	activeTable?: string;
	/** Tables named in the FROM/JOIN list of the statement under the cursor. */
	statementTables?: readonly string[];
}

export interface SchemaCompletionItem {
	label: string;
	kind: SchemaCompletionKind;
	detail: string;
	boost: number;
}

/** See `SqlCompletionSource`'s constants: same magnitudes, same rationale. */
const EXACT_MATCH_BOOST = 40_000;
const PREFIX_MATCH_BOOST = 4_000;
/** Below prefix so a "starts with" hit always outranks a "somewhere inside". */
const SUBSTRING_MATCH_BOOST = 500;

/**
 * The identifier run the cursor sits in. The popup only ever replaces this, so
 * it also keeps the list from firing mid-string or on bare punctuation.
 */
const WORD_BEFORE_CURSOR = /[\p{L}\p{N}_$]+/u;

/**
 * Keywords whose left-hand side wants tables.
 *
 * `(?<![\w$.])` is the "not a qualified name" guard: `t.order` is a column,
 * and `\b` alone would happily read it as an ORDER BY clause.
 */
const TABLE_CLAUSES = /(?<![\w$.])\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\b/gi;

/** Keywords whose left-hand side wants columns; nearest match wins. */
const COLUMN_CLAUSE =
	/(?<![\w$.])\b(?:WHERE|ON|GROUP\s+BY|ORDER\s+BY|HAVING|SET)\b/gi;

/** Hard ceiling on popup size; a 400-column schema must not render 400 rows. */
const MAX_OPTIONS = 200;

/** A `FROM`/`JOIN` clause naming a table, captured as its last path segment. */
const TABLE_REFERENCE =
	/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+("[^"]+"|[\p{L}\p{N}_$]+)/giu;

/**
 * Blanks out comments and quoted literals so their contents cannot be mistaken
 * for a clause keyword (`WHERE` inside `'WHERE'`), while keeping every offset
 * identical — the scan below reports positions in the original document.
 */
function blankOutLiteralsAndComments(text: string): string {
	const out = text.split("");
	let i = 0;
	while (i < text.length) {
		let end = -1;
		if (text.startsWith("--", i)) {
			const newline = text.indexOf("\n", i + 2);
			end = newline === -1 ? text.length : newline;
		} else if (text.startsWith("/*", i)) {
			const close = text.indexOf("*/", i + 2);
			end = close === -1 ? text.length : close + 2;
		} else if (text[i] === "'" || text[i] === '"' || text[i] === "`") {
			const close = text.indexOf(text[i], i + 1);
			end = close === -1 ? text.length : close + 1;
		}
		// An unterminated literal or comment blanks to the end of the statement,
		// which is the same answer a correct one would give here.
		if (end > 0) {
			for (let j = i; j < end; j += 1) {
				if (out[j] !== "\n") out[j] = " ";
			}
			i = end;
			continue;
		}
		i += 1;
	}
	return out.join("");
}

/** Position of the last match of `pattern` in `text`, or -1. */
function lastKeywordEnd(text: string, pattern: RegExp): number {
	let end = -1;
	for (const match of text.matchAll(pattern)) end = match.index + match[0].length;
	return end;
}

/**
 * Tables named by the statement under the cursor, deduplicated.
 *
 * Subqueries contribute names too; that is a hint, not a claim, and offering a
 * table the user cannot see is worse than offering one they can.
 */
export function statementTablesFor(doc: string, pos: number): string[] {
	const start = doc.lastIndexOf(";", Math.max(0, pos - 1)) + 1;
	const cleaned = blankOutLiteralsAndComments(doc.slice(start, pos));
	const seen = new Set<string>();
	const names: string[] = [];
	for (const match of cleaned.matchAll(TABLE_REFERENCE)) {
		const raw = match[1].replace(/"/g, "");
		const name = raw.slice(raw.lastIndexOf(".") + 1);
		const key = name.toLowerCase();
		if (!name || seen.has(key)) continue;
		seen.add(key);
		names.push(name);
	}
	return names;
}

/**
 * Whether the text before `pos` wants tables or columns.
 *
 * Nearest keyword wins, which is what makes `SELECT a FROM t WHERE b` a column
 * clause: `FROM` is the one further from the cursor. Returns null when the
 * cursor is somewhere no suggestion helps — offering tables right after `SELECT`
 * would bury the columns that are actually wanted.
 */
export function schemaClauseFor(
	doc: string,
	pos: number,
): "column" | "table" | null {
	const start = doc.lastIndexOf(";", Math.max(0, pos - 1)) + 1;
	const cleaned = blankOutLiteralsAndComments(doc.slice(start, pos));
	const tableAt = lastKeywordEnd(cleaned, TABLE_CLAUSES);
	const columnAt = lastKeywordEnd(cleaned, COLUMN_CLAUSE);
	if (tableAt < 0 && columnAt < 0) {
		// The projection list itself: `SELECT cre|`.
		return /\bSELECT\b/i.test(cleaned) ? "column" : null;
	}
	if (tableAt < 0) return "column";
	if (columnAt < 0) return "table";
	// `\b` keeps `CREATED_AT` out of `ORDER`; the regexes' lookbehind keeps a
	// qualified name out, so `t.order` stays a column rather than a clause.
	return columnAt > tableAt ? "column" : "table";
}

/**
 * Every table whose columns this clause may offer, nearest declaration first:
 * the tab's own table, then the statement's FROM/JOIN list.
 */
function tablesToSearch(ctx: SchemaCompletionContext): string[] {
	const wanted = [
		...(ctx.activeTable ? [ctx.activeTable] : []),
		...(ctx.statementTables ?? []),
	];
	const seen = new Set<string>();
	const names: string[] = [];
	for (const name of wanted) {
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		names.push(name);
	}
	return names;
}

/**
 * Popup entries for the word typed so far.
 *
 * Starts-with matches are the ones the user meant; a substring pass runs only
 * to fill an otherwise empty list, so it can never displace a real prefix hit.
 */
export function buildSchemaCompletions(
	ctx: SchemaCompletionContext,
	clause: "column" | "table",
	query: string,
): SchemaCompletionItem[] {
	const needle = query.toLowerCase();
	// Keyed by lower-cased name so a column shared by two tables, or a table
	// reached through a differently-cased reference, is one entry with one
	// detail rather than two near-identical ones.
	const entries = new Map<string, SchemaCompletionItem>();
	if (clause === "table") {
		for (const table of ctx.tables) {
			entries.set(table.toLowerCase(), {
				label: table,
				kind: "table",
				detail: "table",
				boost: 0,
			});
		}
	} else {
		for (const table of tablesToSearch(ctx)) {
			for (const column of ctx.columnsFor(table)) {
				const key = column.name.toLowerCase();
				if (entries.has(key)) continue;
				entries.set(key, {
					label: column.name,
					kind: "column",
					detail: column.isPrimaryKey
						? `${column.dataType} PK`
						: column.dataType,
					boost: 0,
				});
			}
		}
	}

	// Starts-with matches are the ones the user meant; the substring pass runs
	// only to fill an otherwise empty list, so it can never displace a real hit.
	const startsWith = (item: SchemaCompletionItem) =>
		item.label.toLowerCase().startsWith(needle);
	const contains = (item: SchemaCompletionItem) =>
		item.label.toLowerCase().includes(needle);
	const rank = (items: SchemaCompletionItem[], boost: number) =>
		items
			.map((item) => ({
				...item,
				boost:
					item.label.toLowerCase() === needle ? EXACT_MATCH_BOOST : boost,
			}))
			.sort(
				(a, b) =>
					b.boost - a.boost ||
					a.label.length - b.label.length ||
					a.label.localeCompare(b.label),
			)
			.slice(0, MAX_OPTIONS);
	const all = [...entries.values()];
	const prefixed = rank(all.filter(startsWith), PREFIX_MATCH_BOOST);
	if (prefixed.length > 0) return prefixed;
	return rank(all.filter(contains), SUBSTRING_MATCH_BOOST);
}

/**
 * Wraps the provider into a CodeMirror `CompletionSource`.
 *
 * Reads the schema through the callback on every invocation and never fetches:
 * the fetch belongs to a watcher over the active tab, so completion itself stays
 * synchronous and a keystroke can never await the network.
 */
export function schemaCompletionSource(
	getContext: () => SchemaCompletionContext,
): CompletionSource {
	return (context: CompletionContext): CompletionResult | null => {
		const word = context.matchBefore(WORD_BEFORE_CURSOR);
		if (!word) return null;
		const doc = context.state.doc.toString();
		// The FROM/JOIN list is read here, not in the caller's context, because
		// only the cursor position says which statement is being typed.
		const ctx: SchemaCompletionContext = {
			...getContext(),
			statementTables: statementTablesFor(doc, context.pos),
		};
		if (ctx.tables.length === 0) return null;
		const clause = schemaClauseFor(doc, context.pos);
		if (!clause) return null;
		const items = buildSchemaCompletions(ctx, clause, word.text);
		if (items.length === 0) return null;
		const options: Completion[] = items.map((item) => ({
			label: item.label,
			detail: item.detail,
			boost: item.boost,
			type: item.kind,
		}));
		return {
			from: word.from,
			options,
			// While the word keeps its identifier shape, the same list still
			// answers; re-scanning the document per keystroke would be waste.
			validFor: WORD_BEFORE_CURSOR,
		};
	};
}
