/**
 * The statement under a caret offset.
 *
 * The editor needs to answer "which statement is this cursor in?" in two
 * places — to draw the DataGrip-style outline and to decide what `Mod-Enter`
 * runs — and both answers have to agree with each other and with the splitter
 * the backend executes with. So this is a thin question asked of
 * `splitSqlStatements` rather than a second scanner: a second scanner is a
 * second opinion about where a statement ends, and the day the two disagree
 * the editor outlines one statement while the server runs another.
 *
 * Pure, synchronous, and free of Vue and CodeMirror so it can be reasoned
 * about (and reused) without either runtime loaded.
 */
import { splitSqlStatements } from "./sqlSplit";
import type { SqlStatement } from "./sqlSplit";

/**
 * Returns the statement containing `position`, or `null` when the offset is
 * in none of them.
 *
 * Boundary rule: the statement's range is closed at both ends — `[start,
 * end]`. `end` is the offset just past the statement's last character, so the
 * trailing `;` sits at `end - 1` and an offset of exactly `end` is the caret
 * immediately after it. That offset is treated as *inside*, because it is
 * where the caret always is the instant a statement has just been typed, and
 * answering "no statement here" would send `Mod-Enter` off to run the rest of
 * the file at the exact moment the user finished writing one.
 *
 * The tie only arises for statements written flush against each other
 * (`select 1;select 2;`), where one statement's `end` is the next one's
 * `start`. The later statement wins there: the caret before `select 2` is
 * about to type into it, not still finishing the first.
 *
 * Genuine whitespace — the blank lines and indentation between statements —
 * belongs to no statement and answers `null`, as does an empty document, an
 * offset outside the string, and the caret sitting past the last statement in
 * trailing whitespace.
 */
export function statementAt(
	sql: string,
	position: number,
): SqlStatement | null {
	if (position < 0 || position > sql.length) return null;
	let found: SqlStatement | null = null;
	for (const statement of splitSqlStatements(sql)) {
		// Statements come back in ascending order, so the first one starting
		// past the caret ends the search.
		if (position < statement.start) break;
		// Keep going instead of returning: the next statement may start exactly
		// where this one ended, and then it is the one the caret is in.
		if (position <= statement.end) found = statement;
	}
	return found;
}