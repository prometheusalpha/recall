/**
 * The scope of one SQL statement, for editor completions.
 *
 * Scans a single statement — never the whole document — after blanking comments
 * and quoted runs, so a keyword inside a literal cannot pass for a clause. It is
 * a scanner, not a parser: it answers "which tables does this statement name,
 * and under which aliases" well enough to offer columns, and stays silent when
 * the shape is odd instead of guessing.
 *
 * Quoted identifiers are blanked along with string literals, so a table called
 * `"My Table"` is invisible here. An absent suggestion beats a rejected one.
 */

/**
 * A table target: its dotted prefix, its name, and its alias.
 *
 * The lookahead after `AS` is the set of words that can follow a table name
 * without being an alias. A wrong alias is worse than a missing one, because it
 * offers columns from a table the statement never mentioned.
 */
const TABLE_REFERENCE =
	/(?<![\w$.])(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+((?:[\p{L}\p{N}_$]+\.)*)([\p{L}\p{N}_$]+)(?:\s+(?:AS\s+)?(?!ON\b|USING\b|WHERE\b|GROUP\b|ORDER\b|HAVING\b|LIMIT\b|OFFSET\b|FETCH\b|FOR\b|UNION\b|EXCEPT\b|INTERSECT\b|VALUES\b|RETURNING\b|SET\b|WINDOW\b|SELECT\b|INSERT\b|UPDATE\b|DELETE\b|WITH\b|AND\b|OR\b|NOT\b|IS\b|IN\b|LIKE\b|BETWEEN\b|CASE\b|WHEN\b|THEN\b|ELSE\b|END\b|JOIN\b|INNER\b|LEFT\b|RIGHT\b|FULL\b|OUTER\b|CROSS\b|NATURAL\b|LATERAL\b|TABLESAMPLE\b|PARTITION\b|CONFLICT\b|DO\b)([\p{L}\p{N}_$]+))?/giu;

/** `WITH` anywhere in the statement is enough to look for CTE names. */
const WITH_PRESENT = /\bWITH\b/i;

/** `<name> AS (` — the declaration shape shared by CTEs and `CREATE TABLE AS`. */
const CTE_NAME = /([\p{L}\p{N}_$]+)\s+AS\s*\(/giu;

/**
 * Blanks out comments and quoted runs so their contents cannot be mistaken for
 * a clause keyword (`WHERE` inside `'WHERE'`), while keeping every offset
 * identical — the scans here report positions in the original text.
 */
export function blankOutLiteralsAndComments(text: string): string {
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

/**
 * The statement around `pos`: from the previous `;` to the next one.
 *
 * A `;` inside a literal ends a "statement" early here, as it does in the
 * scanner the editor already runs. Both ends are hints for a popup, and the
 * cost of being wrong is a shorter search, not a wrong answer.
 */
export function statementBounds(
	doc: string,
	pos: number,
): { start: number; end: number } {
	const start = doc.lastIndexOf(";", Math.max(0, pos - 1)) + 1;
	const next = doc.indexOf(";", pos);
	return { start, end: next === -1 ? doc.length : next };
}

/** One table reference: the name as written, and its alias when it has one. */
interface TableRef {
	name: string;
	alias: string | null;
}

/**
 * Every table reference in already-blanked text, in order.
 *
 * A reference the text leaves open — `FROM public.` while the table name is
 * still being typed — is dropped rather than read as a table called `public`.
 */
function scanTableRefs(cleaned: string): TableRef[] {
	const refs: TableRef[] = [];
	for (const match of cleaned.matchAll(TABLE_REFERENCE)) {
		if (cleaned[match.index + match[0].length] === ".") continue;
		refs.push({ name: match[2], alias: match[3] ?? null });
	}
	return refs;
}

/** What the statement under the cursor declares, for completion purposes. */
export interface StatementScope {
	/** Tables the statement names, last path segment only, in order. */
	tables: string[];
	/** Lower-cased alias or table name to the table it stands for. */
	aliases: Map<string, string>;
	/** Names declared by `WITH ... AS (`: not tables, but still completable. */
	ctes: string[];
}

/**
 * Reads the tables, aliases and CTE names out of one statement.
 *
 * Names are lower-cased for lookup only, never for display: the popup shows
 * what the schema says, not what the user typed.
 */
export function parseStatementScope(statement: string): StatementScope {
	const cleaned = blankOutLiteralsAndComments(statement);
	const tables: string[] = [];
	const aliases = new Map<string, string>();
	const seen = new Set<string>();
	for (const ref of scanTableRefs(cleaned)) {
		const key = ref.name.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			tables.push(ref.name);
		}
		// The table's own name is a qualifier too: `users.` needs no alias.
		if (!aliases.has(key)) aliases.set(key, ref.name);
		if (ref.alias) {
			const alias = ref.alias.toLowerCase();
			if (!aliases.has(alias)) aliases.set(alias, ref.name);
		}
	}

	const ctes: string[] = [];
	if (WITH_PRESENT.test(cleaned)) {
		const declared = new Set<string>();
		for (const match of cleaned.matchAll(CTE_NAME)) {
			const name = match[1];
			const key = name.toLowerCase();
			if (declared.has(key) || seen.has(key)) continue;
			declared.add(key);
			ctes.push(name);
		}
	}

	return { tables, aliases, ctes };
}

/**
 * Every table named anywhere in `doc`, for prefetching a whole tab at once.
 *
 * Deliberately not statement-scoped: warming a cache wants the union, and one
 * pass over blanked text is cheaper than splitting the document first.
 */
export function referencedTablesIn(doc: string): string[] {
	const seen = new Set<string>();
	const names: string[] = [];
	for (const ref of scanTableRefs(blankOutLiteralsAndComments(doc))) {
		const key = ref.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		names.push(ref.name);
	}
	return names;
}
