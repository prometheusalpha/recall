/**
 * SQL statement splitter.
 *
 * IMPORTANT: this mirrors the splitter in the Bun main process. The editor uses
 * it for "run selection" feedback (splitting a selection into statements before
 * handing them to the backend) and the backend uses it to actually execute the
 * batch, so the two MUST stay byte-for-byte compatible in their scanning rules.
 * Any change here must be applied there in the same commit.
 *
 * A semicolon only terminates a statement at top level. Inside `--` line
 * comments, block comments, `'…'` strings, `"…"` / `` `…` `` quoted
 * identifiers, and Postgres dollar-quoted bodies (`$$…$$`, `$tag$…$tag$`) it is
 * ordinary text. Whitespace-only fragments (including the tail after a trailing
 * semicolon) are dropped.
 */
export interface SqlStatement {
	/** The statement text, trimmed, including its terminating `;` when present. */
	sql: string;
	/** Offset of the first non-whitespace character of the statement. */
	start: number;
	/** Offset just past the last character of the statement, exclusive. */
	end: number;
}

type ScanState =
	| "normal"
	| "singleQuote"
	| "doubleQuote"
	| "backtick"
	| "lineComment"
	| "blockComment"
	| "dollarQuote";

/** Characters allowed between the `$` delimiters of a dollar quote. */
function isTagChar(char: string | undefined): boolean {
	if (char === undefined) return false;
	return (
		(char >= "a" && char <= "z") ||
		(char >= "A" && char <= "Z") ||
		(char >= "0" && char <= "9") ||
		char === "_"
	);
}

function isSpace(char: string): boolean {
	return char === " " || char === "\t" || char === "\n" || char === "\r" ||
		char === "\f" || char === "\v";
}

/**
 * Reads the dollar-quote opener at `index` and returns `{ tag, next }`, where
 * `tag` is the full delimiter (e.g. `$$`, `$body$`) and `next` is the offset of
 * the first character of the body. Returns null when the `$` does not open a
 * dollar quote (for example `$1` or `a$b`).
 */
function readDollarTag(
	sql: string,
	index: number,
): { tag: string; next: number } | null {
	let cursor = index + 1;
	while (isTagChar(sql[cursor])) cursor++;
	if (sql[cursor] !== "$") return null;
	return { tag: sql.slice(index, cursor + 1), next: cursor + 1 };
}

/**
 * Splits `sql` into top-level statements. Offsets are relative to the original
 * string so a caller can map each statement back onto editor ranges.
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
	const statements: SqlStatement[] = [];
	const length = sql.length;
	/** Offset of the first non-whitespace character of the current fragment. */
	let contentStart = -1;
	let scan: ScanState = "normal";
	/** Closing delimiter of the dollar-quoted body currently being scanned. */
	let dollarTag = "";

	let index = 0;
	while (index < length) {
		const char = sql[index];
		const next = sql[index + 1];

		if (scan !== "normal") {
			switch (scan) {
				case "singleQuote":
				case "doubleQuote":
				case "backtick": {
					const quote = scan === "singleQuote"
						? "'"
						: scan === "doubleQuote"
							? '"'
							: "`";
					// A doubled quote is an escaped quote, not a terminator.
					if (char === quote && next === quote) {
						index += 2;
						continue;
					}
					if (char === quote) scan = "normal";
					index++;
					continue;
				}
				case "lineComment": {
					if (char === "\n") scan = "normal";
					index++;
					continue;
				}
				case "blockComment": {
					if (char === "*" && next === "/") {
						scan = "normal";
						index += 2;
						continue;
					}
					index++;
					continue;
				}
				case "dollarQuote": {
					if (char === "$" && sql.startsWith(dollarTag, index)) {
						index += dollarTag.length;
						scan = "normal";
						continue;
					}
					index++;
					continue;
				}
			}
		}

		if (char === "-" && next === "-") {
			scan = "lineComment";
			index += 2;
			continue;
		}
		if (char === "/" && next === "*") {
			scan = "blockComment";
			index += 2;
			continue;
		}
		if (char === "'") {
			scan = "singleQuote";
			index++;
			continue;
		}
		if (char === '"') {
			scan = "doubleQuote";
			index++;
			continue;
		}
		if (char === "`") {
			scan = "backtick";
			index++;
			continue;
		}
		if (char === "$") {
			const tag = readDollarTag(sql, index);
			if (tag !== null) {
				dollarTag = tag.tag;
				scan = "dollarQuote";
				index = tag.next;
				continue;
			}
			// A `$` that opens nothing (e.g. `$1`) is ordinary text.
			if (contentStart === -1) contentStart = index;
			index++;
			continue;
		}
		if (char === ";") {
			index++;
			// The terminator belongs to the statement it closes. A fragment
			// holding nothing but `;` is not a statement.
			if (contentStart !== -1) {
				statements.push({
					sql: sql.slice(contentStart, index),
					start: contentStart,
					end: index,
				});
				contentStart = -1;
			}
			continue;
		}
		if (!isSpace(char) && contentStart === -1) contentStart = index;
		index++;
	}

	// Trailing fragment with no terminating `;`.
	if (contentStart !== -1) {
		let end = length;
		while (end > contentStart && isSpace(sql[end - 1])) end--;
		if (end > contentStart) {
			statements.push({
				sql: sql.slice(contentStart, end),
				start: contentStart,
				end,
			});
		}
	}

	return statements;
}
