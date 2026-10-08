/**
 * Schema-aware completions for the SQL editor: table names and column names.
 *
 * Answers synchronously whenever the cache already holds the columns, and
 * otherwise waits one round trip under a short budget — a fetch that outlives
 * the budget answers empty and keeps loading, so the next keystroke finds it
 * cached. `schemaClauseFor` decides whether the cursor wants a table or a
 * column, and `SqlStatementScope` supplies the aliases that make `u.` mean the
 * columns of the table `u` stands for.
 */
import type { ColumnInfo } from "../../../shared/types";
import type {
	Completion,
	CompletionContext,
	CompletionResult,
	CompletionSource,
} from "@codemirror/autocomplete";
import {
	blankOutLiteralsAndComments,
	parseStatementScope,
	statementBounds,
	type StatementScope,
} from "./SqlStatementScope";

/** What the editor hands the source: the tab's schema view, cache-first. */
export interface SchemaCompletionContext {
	/** Tables of the tab's own database and schema. */
	tables: string[];
	/** The table a table-mode tab is showing, when it has one. */
	activeTable?: string;
	/** Columns already cached; empty when the table was never listed. */
	cachedColumns(table: string): ColumnInfo[];
	/** Columns, listing them if the cache is cold. Never rejects. */
	loadColumns(table: string): Promise<ColumnInfo[]>;
	/** Tables of another schema in the same database, for `schema.`. */
	tablesInSchema?(schema: string): string[];
}

export type SchemaCompletionKind = "table" | "column";

export interface SchemaCompletionItem {
	label: string;
	kind: SchemaCompletionKind;
	detail: string;
	boost: number;
}

/** One clause's candidates, with its columns already resolved. */
export interface CompletionRequest {
	clause: SchemaCompletionKind;
	/** Names for a table clause; ignored for a column clause. */
	tables: string[];
	/** CTE names, offered beside real tables. */
	ctes: string[];
	/** Columns per table, already read. */
	columnsByTable: Map<string, ColumnInfo[]>;
	query: string;
}

/** See `SqlCompletionSource`'s constants: same magnitudes, same rationale. */
const EXACT_MATCH_BOOST = 40_000;
const PREFIX_MATCH_BOOST = 4_000;
/** Below prefix so a "starts with" hit always outranks a "somewhere inside". */
const SUBSTRING_MATCH_BOOST = 500;

/** Hard ceiling on popup size; a 400-column table must not render 400 rows. */
const MAX_OPTIONS = 200;

/**
 * How long a cold column list may hold the popup. Past this the source answers
 * empty while the fetch keeps running: a slow server costs a pause, never a
 * wrong list, because the next keystroke re-runs the source over fresh cache.
 */
const COLUMN_BUDGET_MS = 250;

/**
 * The identifier run the cursor sits in. The popup only ever replaces this, so
 * it also keeps the list from firing mid-string or on bare punctuation.
 */
const WORD_BEFORE_CURSOR = /[\p{L}\p{N}_$]+/u;

/** `<qualifier>.` and the word being typed after it, quoted or bare. */
const QUALIFIED_TARGET =
	/(?:"([^"]+)"|([\p{L}\p{N}_$]+))\s*\.\s*([\p{L}\p{N}_$]*)$/u;

/** Keywords whose right-hand side wants tables. */
const TABLE_CLAUSES = /(?<![\w$.])\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\b/gi;

/** Keywords whose right-hand side wants columns; nearest match wins. */
const COLUMN_CLAUSE =
	/(?<![\w$.])\b(?:WHERE|ON|GROUP\s+BY|ORDER\s+BY|HAVING|SET)\b/gi;

/**
 * A cursor already past the keyword wants the list without having typed a
 * letter of it: `FROM |` should offer tables. Ranked per keystroke, which is
 * cheap, and the popup survives the wait — CodeMirror keeps the previous list
 * on screen, disabled, while a source is running.
 */
const OPEN_CLAUSE_TAIL =
	/(?:\b(?:FROM|JOIN|INTO|UPDATE|TABLE|WHERE|ON|SET|HAVING|SELECT|VALUES|USING|RETURNING|GROUP\s+BY|ORDER\s+BY)|,)\s*$/i;

/**
 * The longest run one completion scans. A megabyte statement is a data load,
 * not a query, and blanking one per keystroke would be the only real cost here.
 * Clause detection reads the tail it can see; aliases, the head.
 */
const SCAN_LIMIT = 64_000;

/** Shared empty map: a table clause never reads it, and nothing writes it. */
const NO_COLUMNS = new Map<string, ColumnInfo[]>();

/** Position of the last match of `pattern` in `text`, or -1. */
function lastKeywordEnd(text: string, pattern: RegExp): number {
	let end = -1;
	for (const match of text.matchAll(pattern)) end = match.index + match[0].length;
	return end;
}

/**
 * Whether `before` — the statement up to the cursor, already blanked — wants
 * tables or columns.
 *
 * Nearest keyword wins, which is what makes `SELECT a FROM t WHERE b` a column
 * clause: `FROM` is the one further from the cursor. Null when the cursor is
 * somewhere no suggestion helps — offering tables right after `SELECT` would
 * bury the columns that are actually wanted.
 */
export function schemaClauseFor(before: string): "column" | "table" | null {
	const tableAt = lastKeywordEnd(before, TABLE_CLAUSES);
	const columnAt = lastKeywordEnd(before, COLUMN_CLAUSE);
	if (tableAt < 0 && columnAt < 0) {
		// The projection list itself: `SELECT cre|`.
		return /\bSELECT\b/i.test(before) ? "column" : null;
	}
	if (tableAt < 0) return "column";
	if (columnAt < 0) return "table";
	// `\b` keeps `CREATED_AT` out of `ORDER`; the regexes' lookbehind keeps a
	// qualified name out, so `t.order` stays a column rather than a clause.
	return columnAt > tableAt ? "column" : "table";
}

/**
 * Popup entries for the word typed so far.
 *
 * Starts-with matches are the ones the user meant; a substring pass runs only
 * to fill an otherwise empty list, so it can never displace a real prefix hit.
 */
export function buildSchemaCompletions(
	request: CompletionRequest,
): SchemaCompletionItem[] {
	const needle = request.query.toLowerCase();
	// Keyed by lower-cased name so a column shared by two tables, or a table
	// reached through a differently-cased reference, is one entry with one
	// detail rather than two near-identical ones.
	const entries = new Map<string, SchemaCompletionItem>();
	if (request.clause === "table") {
		for (const cte of request.ctes) {
			const key = cte.toLowerCase();
			if (entries.has(key)) continue;
			entries.set(key, { label: cte, kind: "table", detail: "CTE", boost: 0 });
		}
		for (const table of request.tables) {
			const key = table.toLowerCase();
			if (entries.has(key)) continue;
			entries.set(key, {
				label: table,
				kind: "table",
				detail: "table",
				boost: 0,
			});
		}
	} else {
		for (const columns of request.columnsByTable.values()) {
			for (const column of columns) {
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

	const startsWith = (item: SchemaCompletionItem) =>
		item.label.toLowerCase().startsWith(needle);
	const contains = (item: SchemaCompletionItem) =>
		item.label.toLowerCase().includes(needle);
	const rank = (items: SchemaCompletionItem[], boost: number) =>
		items
			.map((item) => ({
				...item,
				boost: item.label.toLowerCase() === needle ? EXACT_MATCH_BOOST : boost,
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

/** Deduplicated names, case-insensitive, first spelling wins. */
function uniqueNames(names: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const name of names) {
		const key = name.toLowerCase();
		if (!name || seen.has(key)) continue;
		seen.add(key);
		out.push(name);
	}
	return out;
}

/**
 * `work` or null, whichever lands first.
 *
 * The timer is cleared as soon as the work settles, so a budget can never keep
 * the event loop awake after its answer has already been used.
 */
function withBudget<T>(work: Promise<T>, ms: number): Promise<T | null> {
	const { promise, resolve } = Promise.withResolvers<T | null>();
	const timer = setTimeout(() => resolve(null), ms);
	const settle = (value: T | null) => {
		clearTimeout(timer);
		resolve(value);
	};
	work.then(settle, () => settle(null));
	return promise;
}

/**
 * Lists the tables whose columns are still missing, and records them in `into`.
 *
 * One `loadColumns` per table, and that call is itself cache-first, so a burst
 * of keystrokes over one statement costs one RPC per table per TTL window.
 */
async function loadMissing(
	ctx: SchemaCompletionContext,
	tables: string[],
	into: Map<string, ColumnInfo[]>,
): Promise<void> {
	await Promise.all(
		tables.map(async (table) => {
			if ((into.get(table)?.length ?? 0) > 0) return;
			try {
				into.set(table, await ctx.loadColumns(table));
			} catch {
				// A rejecting loader is a cache miss, not an editor failure.
			}
		}),
	);
}

/** Turns ranked items into a CodeMirror result. */
function toResult(
	items: SchemaCompletionItem[],
	from: number,
	validFor: RegExp,
): CompletionResult {
	const options: Completion[] = items.map((item) => ({
		label: item.label,
		detail: item.detail,
		boost: item.boost,
		type: item.kind,
	}));
	return { from, options, validFor };
}

/**
 * Columns of `tables`, cache first.
 *
 * With any cached hit the answer is immediate and the missing tables load in
 * the background. With none it waits, up to {@link COLUMN_BUDGET_MS}; answering
 * nothing is honest, because the fetch is still in flight and the next
 * keystroke will find it done.
 */
function columnCompletion(
	ctx: SchemaCompletionContext,
	tables: string[],
	query: string,
	from: number,
): CompletionResult | null | Promise<CompletionResult | null> {
	if (tables.length === 0) return null;
	const columnsByTable = new Map<string, ColumnInfo[]>();
	let cachedHits = 0;
	for (const table of tables) {
		const columns = ctx.cachedColumns(table);
		if (columns.length > 0) cachedHits += 1;
		columnsByTable.set(table, columns);
	}
	const finish = () => {
		const items = buildSchemaCompletions({
			clause: "column",
			tables: [],
			ctes: [],
			columnsByTable,
			query,
		});
		return items.length > 0 ? toResult(items, from, WORD_BEFORE_CURSOR) : null;
	};
	if (cachedHits > 0) {
		void loadMissing(ctx, tables, columnsByTable);
		return finish();
	}
	return (async () => {
		const loader = loadMissing(ctx, tables, columnsByTable);
		// Only the budget's own answer is null: a finished load resolves to
		// nothing at all, which is not a failure.
		if ((await withBudget(loader, COLUMN_BUDGET_MS)) === null) return null;
		return finish();
	})();
}

/**
 * `u.` / `users.` / `public.` — the qualified shapes.
 *
 * Returns null when the qualifier names nothing this tab can see, which hands
 * the call to the unqualified path: a word is not a qualifier just because a
 * dot follows it.
 */
function qualifiedCompletion(
	ctx: SchemaCompletionContext,
	scope: StatementScope,
	match: RegExpExecArray,
	pos: number,
): CompletionResult | null | Promise<CompletionResult | null> {
	const qualifier = match[1] ?? match[2];
	const partial = match[3] ?? "";
	const from = pos - partial.length;
	const table = scope.aliases.get(qualifier.toLowerCase());
	if (table) return columnCompletion(ctx, [table], partial, from);

	const names = uniqueNames(ctx.tablesInSchema?.(qualifier) ?? []).filter(
		(name) => name.toLowerCase() !== qualifier.toLowerCase(),
	);
	if (names.length === 0) return null;
	const items = buildSchemaCompletions({
		clause: "table",
		tables: names,
		ctes: [],
		columnsByTable: NO_COLUMNS,
		query: partial,
	});
	return items.length > 0 ? toResult(items, from, WORD_BEFORE_CURSOR) : null;
}

/**
 * Wraps the provider into a CodeMirror `CompletionSource`.
 *
 * `getContext` is cheap by contract — it walks caches, never the wire — and is
 * read on every word the user types. The column fetch belongs to that context,
 * which is why this can stay a source and not a fetcher.
 */
export function schemaCompletionSource(
	getContext: () => SchemaCompletionContext,
): CompletionSource {
	return (context: CompletionContext) => {
		const doc = context.state.doc.toString();
		const bounds = statementBounds(doc, context.pos);
		const before = blankOutLiteralsAndComments(
			doc.slice(Math.max(bounds.start, context.pos - SCAN_LIMIT), context.pos),
		);
		// The whole statement, not just what precedes the cursor: `SELECT u.|`
		// typed before its own `FROM users u` is still the same alias.
		const statement = doc.slice(
			bounds.start,
			Math.min(bounds.end, bounds.start + SCAN_LIMIT),
		);
		const scope = parseStatementScope(statement);
		const ctx = getContext();

		const qualified = QUALIFIED_TARGET.exec(before);
		if (qualified) return qualifiedCompletion(ctx, scope, qualified, context.pos);

		const word = context.matchBefore(WORD_BEFORE_CURSOR);
		// A word the cursor is inside, or a clause it has not started typing.
		if (!word && !OPEN_CLAUSE_TAIL.test(before)) return null;
		const query = word?.text ?? "";
		const from = word?.from ?? context.pos;
		const clause = schemaClauseFor(before);
		if (!clause) return null;

		if (clause === "table") {
			if (ctx.tables.length === 0 && scope.ctes.length === 0) return null;
			const items = buildSchemaCompletions({
				clause: "table",
				tables: ctx.tables,
				ctes: scope.ctes,
				columnsByTable: NO_COLUMNS,
				query,
			});
			return items.length > 0 ? toResult(items, from, WORD_BEFORE_CURSOR) : null;
		}

		// The tab's own table comes first: it is the one on screen, and the one
		// the editor prefetches without being asked.
		const targets = uniqueNames([
			...(ctx.activeTable ? [ctx.activeTable] : []),
			...scope.tables,
		]);
		return columnCompletion(ctx, targets, query, from);
	};
}
