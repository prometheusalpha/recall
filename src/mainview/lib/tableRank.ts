/**
 * How far down Quick Open pushes a table regardless of match quality: 0 for an
 * ordinary table, 1 for a `_`-prefixed one, 2 for anything in a system schema.
 * Applied before the fuzzy score, so a system table never outranks user data
 * even when it is the closer match.
 */

/**
 * Catalog schemas across the dialects. MySQL rows carry the database as their
 * schema (`useTableCatalog`), so `mysql`, `sys`, ... are caught here too.
 */
const SYSTEM_SCHEMAS = new Set([
	"information_schema",
	"pg_catalog",
	"pg_toast",
	"mysql",
	"sys",
	"performance_schema",
]);

export function isSystemSchema(name: string): boolean {
	const lower = name.toLowerCase();
	return SYSTEM_SCHEMAS.has(lower) || lower.startsWith("pg_");
}

export function tableDemotion(table: { schema: string; table: string }): number {
	if (isSystemSchema(table.schema)) return 2;
	return table.table.startsWith("_") ? 1 : 0;
}
