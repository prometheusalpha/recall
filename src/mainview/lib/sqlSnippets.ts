/**
 * Mnemonic SQL snippets.
 *
 * A snippet is a short prefix (`svt`, `cte`) the user types in the editor and
 * accepts from the completion popup. On accept, the body is inserted as a
 * CodeMirror snippet template, so `${1:placeholder}` fields become real
 * tab-stops. Nothing here rewrites a body: what the user edits in the settings
 * dialog is byte-for-byte what the editor inserts.
 *
 * The built-ins are dialect-neutral (valid on both Postgres and MySQL) so the
 * user does not have to think about which engine a template came from.
 */
export interface SqlSnippet {
	id: string;
	/** Human label shown in the completion popup and the settings table. */
	label: string;
	/** The mnemonic the user types. Unique across all snippets. */
	prefix: string;
	/** CodeMirror snippet template, `${n:placeholder}` fields included. */
	body: string;
	enabled: boolean;
}

/** The snippets every install starts with. */
export const DEFAULT_SQL_SNIPPETS: SqlSnippet[] = [
	{
		id: "builtin-sel",
		label: "select *",
		prefix: "sel",
		body: "SELECT *\nFROM ${1:table};",
		enabled: true,
	},
	{
		id: "builtin-ins",
		label: "insert into",
		prefix: "ins",
		body: "INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});",
		enabled: true,
	},
	{
		id: "builtin-upd",
		label: "update set",
		prefix: "upd",
		body: "UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};",
		enabled: true,
	},
	{
		id: "builtin-del",
		label: "delete from",
		prefix: "del",
		body: "DELETE FROM ${1:table}\nWHERE ${2:condition};",
		enabled: true,
	},
	{
		id: "builtin-cte",
		label: "common table expression",
		prefix: "cte",
		body: "WITH ${1:name} AS (\n  SELECT ${2:columns}\n  FROM ${3:table}\n)\nSELECT *\nFROM ${1:name};",
		enabled: true,
	},
	{
		id: "builtin-join",
		label: "join",
		prefix: "join",
		body: "JOIN ${1:table} ON ${2:left_column} = ${3:right_column}",
		enabled: true,
	},
	{
		id: "builtin-case",
		label: "case when",
		prefix: "case",
		body: "CASE\n  WHEN ${1:condition} THEN ${2:value}\n  ELSE ${3:default}\nEND",
		enabled: true,
	},
	{
		id: "builtin-ct",
		label: "create table",
		prefix: "ct",
		body: "CREATE TABLE ${1:table} (\n  ${2:column} ${3:type}\n);",
		enabled: true,
	},
	{
		id: "builtin-ci",
		label: "create index",
		prefix: "ci",
		body: "CREATE INDEX ${1:index_name}\nON ${2:table} (${3:column});",
		enabled: true,
	},
	{
		id: "builtin-ex",
		label: "explain analyze",
		prefix: "ex",
		body: "EXPLAIN ANALYZE\n${1:statement};",
		enabled: true,
	},
	{
		id: "builtin-fn",
		label: "create function",
		prefix: "fn",
		body: "CREATE OR REPLACE FUNCTION ${1:name}(${2:arguments})\nRETURNS ${3:return_type}\nLANGUAGE ${4:language}\nAS ${5:body};",
		enabled: true,
	},
	{
		id: "builtin-updall",
		label: "update every row (no WHERE — destructive)",
		prefix: "updall",
		body: "UPDATE ${1:table}\nSET ${2:column} = ${3:value};",
		enabled: true,
	},
];

/**
 * Prefix identity is case-insensitive: typing `SVT` and `svt` would otherwise
 * produce two completion entries the user cannot tell apart. The original case
 * is preserved on the snippet, only the comparison key is lowercased.
 *
 * The store's duplicate check and the completion source both compare through
 * this key, so they have to stay in lockstep.
 */
export function snippetPrefixKey(prefix: string): string {
	return prefix.trim().toLowerCase();
}

let idCounter = 0;

/** Ids only have to be unique and stable; `crypto` is not always present. */
export function createSnippetId(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (uuid) return uuid;
	idCounter += 1;
	return `snippet-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Coerces anything that was read back from storage into a usable snippet list.
 *
 * Never throws: a non-array, a truncated write or hand-edited JSON all fall
 * back to the built-ins rather than leaving the editor with nothing to expand.
 */
export function normalizeSnippets(raw: unknown): SqlSnippet[] {
	if (!Array.isArray(raw)) return DEFAULT_SQL_SNIPPETS.map((s) => ({ ...s }));
	const byPrefix = new Map<string, SqlSnippet>();
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as Partial<Record<keyof SqlSnippet, unknown>>;
		if (typeof candidate.prefix !== "string") continue;
		if (typeof candidate.body !== "string") continue;
		const prefix = candidate.prefix.trim();
		const body = candidate.body.trim();
		if (!prefix || !body) continue;
		const label =
			typeof candidate.label === "string" && candidate.label.trim()
				? candidate.label.trim()
				: prefix;
		const id =
			typeof candidate.id === "string" && candidate.id.trim()
				? candidate.id.trim()
				: createSnippetId();
		// Last one wins, so a restore that briefly writes two snippets with the
		// same prefix settles on the newer one instead of dropping both.
		byPrefix.set(snippetPrefixKey(prefix), {
			id,
			label,
			prefix,
			body,
			enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : true,
		});
	}
	if (byPrefix.size === 0) return DEFAULT_SQL_SNIPPETS.map((s) => ({ ...s }));
	return [...byPrefix.values()];
}
