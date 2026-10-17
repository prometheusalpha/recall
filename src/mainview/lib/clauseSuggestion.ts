/**
 * Column suggestions for the raw `WHERE` / `ORDER BY` fragments in the result
 * filter band.
 *
 * The field holds SQL the user typed rather than a structure we own, so the
 * list has to read the fragment around the caret before it can answer: `id =
 * '73ba` is inside a literal and has nothing to suggest, `id = ` wants a field,
 * and `id = 1 ` wants the connector that keeps the expression going. Which one
 * it is comes from the text immediately left of the caret, and that is the whole
 * rule set below — a token scan, not a parser.
 *
 * Quoting follows the dialect, so a mixed-case Postgres column inserts as
 * `"OrderId"` while `order_id` stays bare.
 */
import type { DatabaseType } from "../../shared/types";
import { matchFuzzy } from "./fuzzy";
import { codeMirrorSqlDialect } from "./sqlDialect";

/** The fragment a field edits: the grid appends these to the statement. */
export type ClauseKind = "where" | "orderBy";

/** What the fragment at the caret is waiting for. */
export type ClauseSuggestionRole = "field" | "connector" | "none";

/** The identifier run under the caret, and the span a pick replaces. */
export interface ClauseTarget {
	/** The whole fragment: the role is read from the text left of the caret. */
	value: string;
	/** What the user has typed of the identifier under the caret. */
	token: string;
	/** Replacement span: the run under the caret, or the selection when there is one. */
	from: number;
	to: number;
	/** The caret is inside a quoted identifier, so its content is what changes. */
	quotedIdentifier: boolean;
	/** The caret is inside a string literal, where nothing is suggested. */
	insideString: boolean;
}

export interface ClauseFieldSuggestion {
	column: string;
	/** What a pick writes: the name, quoted when the dialect requires it. */
	insertText: string;
}

export interface ClauseFieldSuggestionOptions {
	columns: readonly string[];
	token: string;
	quotedIdentifier: boolean;
	dbType?: DatabaseType;
}

/**
 * The identifier run at the caret. Punctuation that opens a new token — an
 * operator, a bracket, a comma — ends it, so the `id` of `id = na` is not part
 * of the token being typed.
 */
const WHERE_TOKEN_BEFORE = /([^\s,()><=!&|]+)$/;
const WHERE_TOKEN_AFTER = /^([^\s,()><=!&|]+)/;
/** ORDER BY has no operators, so `-` and `>` stay inside names. */
const ORDER_BY_TOKEN_BEFORE = /([^\s,()]+)$/;
const ORDER_BY_TOKEN_AFTER = /^([^\s,()]+)/;

/**
 * Operators whose right-hand side is a value: `deleted_at IS`, `name LIKE`,
 * `id BETWEEN`. A list of columns there answers the wrong question, and the
 * operand is the user's own text.
 */
const VALUE_OPERATOR =
	/(?:^|[\s(])(?:IS(?:\s+NOT)?|(?:NOT\s+)?(?:LIKE|ILIKE|IN|BETWEEN)|SIMILAR\s+TO|REGEXP|RLIKE|GLOB|MATCH)\s*$/i;

const CONNECTORS = ["AND", "OR"] as const;

/**
 * Identifiers that resolve to themselves unquoted. Postgres folds bare names to
 * lower case; MySQL keeps their case but allows no space, dash or dot.
 */
const BARE_IDENTIFIER: Record<DatabaseType, RegExp> = {
	postgres: /^[a-z_][a-z0-9_$]*$/,
	mysql: /^[A-Za-z_$][A-Za-z0-9_$]*$/,
};

/**
 * The quote each dialect writes around an identifier it cannot take bare, and
 * reads back when the user quoted one themselves.
 */
export const IDENTIFIER_QUOTES: Record<DatabaseType, string> = {
	postgres: '"',
	mysql: "`",
};

interface ActiveQuote {
	kind: "identifier" | "string";
	close: string;
	contentStart: number;
}

/** Per-dialect reserved words, read from the dialect once. */
const reservedWordCache = new Map<DatabaseType, ReadonlySet<string>>();

/**
 * A bare identifier whose spelling is a keyword parses as the keyword, so the
 * dialect's own word list decides that half of the quoting rule.
 */
function reservedWords(dbType: DatabaseType): ReadonlySet<string> {
	const cached = reservedWordCache.get(dbType);
	if (cached !== undefined) return cached;
	const declared = codeMirrorSqlDialect(dbType).spec.keywords ?? "";
	const words = new Set(
		declared
			.split(/\s+/)
			.filter((word) => word !== "")
			.map((word) => word.toLowerCase()),
	);
	reservedWordCache.set(dbType, words);
	return words;
}

/**
 * The quote the caret sits inside, if any.
 *
 * Scanned from the start rather than searched backwards: whether a quote opens
 * or closes depends on the state the previous ones left behind. A doubled quote
 * escapes itself in both kinds, and a backslash escapes only inside a string.
 */
function activeQuoteAt(
	value: string,
	cursor: number,
	identifierQuote: string | undefined,
): ActiveQuote | undefined {
	let active: ActiveQuote | undefined;
	for (let index = 0; index < cursor; index += 1) {
		const character = value[index];
		if (active === undefined) {
			if (identifierQuote !== undefined && character === identifierQuote) {
				active = {
					kind: "identifier",
					close: identifierQuote,
					contentStart: index + 1,
				};
			} else if (
				character === "'" ||
				(character === '"' && identifierQuote !== '"')
			) {
				active = { kind: "string", close: character, contentStart: index + 1 };
			}
			continue;
		}
		if (active.kind === "string" && character === "\\") {
			index += 1;
			continue;
		}
		if (character !== active.close) continue;
		if (value[index + 1] === active.close && index + 2 <= cursor) {
			index += 1;
			continue;
		}
		active = undefined;
	}
	return active;
}

/**
 * Reads the fragment at the caret and returns what a pick would replace.
 *
 * A selection wins over the run under the caret: having selected text is the
 * user saying exactly what the pick goes over. Inside a quoted identifier only
 * its content is replaced, so quoting the user already typed survives.
 */
export function clauseTarget(
	kind: ClauseKind,
	value: string,
	caret: number,
	selectionEnd: number | undefined,
	identifierQuote?: string,
): ClauseTarget {
	const start = Math.min(Math.max(caret, 0), value.length);
	const end = Math.min(Math.max(selectionEnd ?? start, start), value.length);
	const quote =
		kind === "where" ? activeQuoteAt(value, start, identifierQuote) : undefined;

	if (quote?.kind === "string") {
		return {
			value,
			token: "",
			from: start,
			to: end,
			quotedIdentifier: false,
			insideString: true,
		};
	}

	if (quote?.kind === "identifier") {
		const selected = start !== end;
		const close = selected ? -1 : value.indexOf(quote.close, start);
		return {
			value,
			token: selected ? value.slice(start, end) : value.slice(quote.contentStart, start),
			from: selected ? start : quote.contentStart,
			to: !selected && close >= 0 ? close : end,
			quotedIdentifier: true,
			insideString: false,
		};
	}

	if (start !== end) {
		return {
			value,
			token: value.slice(start, end),
			from: start,
			to: end,
			quotedIdentifier: false,
			insideString: false,
		};
	}

	// The run under the caret extends forward too: the arrow keys can park the
	// caret inside a name, and a pick then replaces the whole name, not a tail.
	const before = value
		.slice(0, start)
		.match(kind === "where" ? WHERE_TOKEN_BEFORE : ORDER_BY_TOKEN_BEFORE);
	const token = before?.[1] ?? "";
	const after = value
		.slice(start)
		.match(kind === "where" ? WHERE_TOKEN_AFTER : ORDER_BY_TOKEN_AFTER);
	return {
		value,
		token,
		from: start - token.length,
		to: start + (after?.[1].length ?? 0),
		quotedIdentifier: false,
		insideString: false,
	};
}

/**
 * What the fragment at the caret wants: a field, the connector that continues
 * an expression, or nothing at all.
 *
 * `orderBy` is always a field list — it has no connectors and no values.
 */
export function clauseRole(
	kind: ClauseKind,
	target: ClauseTarget,
): ClauseSuggestionRole {
	if (kind !== "where") return "field";
	if (target.insideString) return "none";
	if (target.quotedIdentifier) return "field";
	const prefix = target.value.slice(0, target.from).trimEnd();
	if (VALUE_OPERATOR.test(prefix)) return "none";
	if (
		prefix === "" ||
		/(?:^|\s)(?:AND|OR|NOT)$/i.test(prefix) ||
		/[,(<>=!~+\-*/]$/.test(prefix)
	) {
		return "field";
	}
	return "connector";
}

/** The connectors the typed token is a prefix of, exact match excluded. */
export function clauseConnectors(token: string): string[] {
	const lower = token.toLowerCase();
	return CONNECTORS.filter(
		(keyword) =>
			keyword.toLowerCase().startsWith(lower) &&
			keyword.toLowerCase() !== lower,
	);
}

/**
 * Columns for the token at the caret, best match first.
 *
 * A token no column matches gets an empty list rather than every column. A
 * number or a literal is the operand the user is in the middle of writing, and
 * a full-list fallback there is what made Enter — the keystroke that applies
 * the clause — look like it had rewritten the value. A token that IS a column
 * ends the list for the same reason: the name is complete, and what follows is
 * an operator.
 */
export function clauseFieldSuggestions(
	options: ClauseFieldSuggestionOptions,
): ClauseFieldSuggestion[] {
	const { columns, token, quotedIdentifier, dbType } = options;
	const lower = token.toLowerCase();
	if (
		lower !== "" &&
		columns.some((column) => column.toLowerCase() === lower)
	) {
		return [];
	}

	const scored: Array<{ column: string; score: number; index: number }> = [];
	let index = 0;
	for (const column of columns) {
		const score = lower === "" ? 0 : (matchFuzzy(lower, column)?.score ?? -1);
		if (score < 0) continue;
		scored.push({ column, score, index: index++ });
	}
	scored.sort(
		(left, right) => left.score - right.score || left.index - right.index,
	);

	return scored.map((entry) => ({
		column: entry.column,
		// Inside quotes the name is already delimited, so the quotes survive
		// whatever the dialect would have added.
		insertText: quotedIdentifier
			? entry.column
			: clauseInsertText(entry.column, dbType),
	}));
}

/**
 * The name as a pick should write it: quoted only when the dialect needs it, so
 * a readable fragment stays readable.
 */
export function clauseInsertText(column: string, dbType?: DatabaseType): string {
	if (dbType === undefined) return column;
	if (
		BARE_IDENTIFIER[dbType].test(column) &&
		!reservedWords(dbType).has(column.toLowerCase())
	) {
		return column;
	}
	const quote = IDENTIFIER_QUOTES[dbType];
	return `${quote}${column.split(quote).join(quote + quote)}${quote}`;
}

export interface ClausePick {
	value: string;
	/** Where the caret belongs after the pick, ready for the operator. */
	caret: number;
}

export interface ClausePickOptions {
	kind: ClauseKind;
	value: string;
	caret: number;
	selectionEnd?: number;
	insertText: string;
	identifierQuote?: string;
}

/**
 * The fragment after a pick, and where the caret lands.
 *
 * A pick that lands past the end of the fragment writes the space the operator
 * will follow; one that replaces a name being typed leaves the text around it
 * alone, and one inside a quoted identifier keeps the quotes the user typed
 * rather than adding the dialect's own.
 */
export function clausePick(options: ClausePickOptions): ClausePick {
	const target = clauseTarget(
		options.kind,
		options.value,
		options.caret,
		options.selectionEnd,
		options.identifierQuote,
	);
	const suffix =
		target.token === "" &&
		!target.quotedIdentifier &&
		!target.insideString &&
		target.from >= options.value.length
			? " "
			: "";
	return {
		value: `${options.value.slice(0, target.from)}${options.insertText}${suffix}${options.value.slice(target.to)}`,
		caret: target.from + options.insertText.length + suffix.length,
	};
}
