/**
 * SQL formatting for the editor.
 *
 * `sql-formatter` is reached through a dynamic `import()`, the same way
 * `SqlEditor.vue` reaches CodeMirror. A static import cannot be used here
 * because the library carries a tokenizer and a grammar for twenty dialects,
 * and all of it would land in the entry chunk that paints the first window —
 * formatting is an on-demand action, so its grammar stays in its own chunk.
 * Nothing may import this module statically without losing that split.
 *
 * Pure and free of Vue and CodeMirror, so the formatting itself can be
 * exercised without either runtime loaded.
 */
import type { SqlLanguage } from "sql-formatter";
import type { DatabaseType } from "../../shared/types";

/** `sql-formatter`'s id for each `DatabaseType` the app can run against. */
const LANGUAGES: Record<DatabaseType, SqlLanguage> = {
	postgres: "postgresql",
	mysql: "mysql",
};

/**
 * Formats one statement, or one selection, and returns the text.
 *
 * Everything but the dialect stays on the library's defaults: keyword case is
 * preserved, because recasing the user's own SQL is a preference the app has
 * nowhere to ask for, and the indent is two spaces, which is the width `Tab`
 * inserts in the editor.
 *
 * Throws whatever the parser throws. For some unparseable inputs that message
 * is a listing of every symbol the grammar would have accepted, thousands of
 * characters of it, so the caller trims it before showing it.
 */
export async function formatSqlText(
	sql: string,
	dbType: DatabaseType,
): Promise<string> {
	const { format } = await import("sql-formatter");
	return format(sql, { language: LANGUAGES[dbType] });
}
