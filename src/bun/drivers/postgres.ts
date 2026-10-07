import type { SQL } from "bun";
import type {
	ColumnInfo,
	ConnectionConfig,
	DatabaseConnectionInfo,
	ForeignKeyInfo,
	IndexInfo,
	TableInfo,
	TriggerInfo,
} from "../../shared/types";
import type { Driver, SQLOptions } from "../driver";
import {
	isReadStatement,
	normalizeBackendError,
	parseUrlParams,
	wrapForColumnTypeProbePlanOnly,
} from "../driver";

/**
 * Session timezone forced on every session, unless the profile sets its own
 * `timezone` in `urlParams`.
 *
 * Cottontail 0.7.1 bundles Bun 1.3.10, whose `parsePostgresTimestamp` hands
 * `timestamptz` text to `Date.parse`. Postgres renders a whole-hour offset as
 * `+00` with no minutes, which is not a JS date format, so the cell decodes to
 * an Invalid Date and `toJsonSafe` turns that into `null` — every
 * `timestamptz` cell renders as NULL. Bun parses `±HH:MM` correctly, so any
 * offset carrying minutes avoids the bug.
 *
 * `+07` does NOT work: Postgres renders the offset from the actual value in
 * its shortest form, so a whole-hour zone still prints `+07`. Only an offset
 * with non-zero minutes prints long enough to survive.
 *
 * This is a workaround, not a fix. It shifts the session timezone, so
 * `now()::timestamp` and `to_char(now(), ...)` report +05:45 rather than the
 * server default. `timestamptz` cells in the grid are unaffected — the driver
 * normalises them to UTC before they leave the Bun side.
 *
 * Remove once Cottontail bundles the fix from oven-sh/bun#35505, which parses
 * the offset components itself instead of calling `Date.parse`.
 */
const FORCED_SESSION_TIMEZONE = "+05:45";
/** Postgres runtime parameters `ConnectionConfig.urlParams` may carry. */
const PG_RUNTIME_PARAMS = new Set([
	"sslmode",
	"connect_timeout",
	"sslrootcert",
	"sslcert",
	"sslkey",
	"sslcrl",
	"target_session_attrs",
]);

const TABLE_TYPE_BY_RELKIND: Record<string, string> = {
	r: "table",
	p: "partitioned table",
	v: "view",
	m: "materialized view",
	f: "foreign table",
};

export const postgresDriver: Driver = {
	dbType: "postgres",
	databaseScoped: true,

	buildOptions(cfg: ConnectionConfig): SQLOptions {
		const params = parseUrlParams(cfg.urlParams);
		const runtime: Record<string, string | boolean | number> = {};
		// `ssl` maps to libpq's sslmode; an explicit sslmode in urlParams wins.
		let tls: SQL.PostgresOrMySQLOptions["tls"] = cfg.ssl
			? "require"
			: false;
		let connectionTimeout =
			cfg.connectTimeoutSecs > 0 ? cfg.connectTimeoutSecs : 30;

		for (const [key, value] of params) {
			if (key === "sslmode") {
				tls = value as SQL.PostgresOrMySQLOptions["tls"];
			} else if (key === "connect_timeout") {
				const seconds = Number(value);
				if (Number.isFinite(seconds) && seconds > 0) connectionTimeout = seconds;
			} else if (!PG_RUNTIME_PARAMS.has(key)) {
				// Everything else is a libpq runtime parameter (application_name,
				// search_path, statement_timeout, …); Bun forwards it in `connection`.
				runtime[key] = value;
			}
		}

		// See FORCED_SESSION_TIMEZONE: an explicit `timezone` in the profile's
		// urlParams wins, since the user stated it deliberately.
		if (runtime.timezone === undefined) {
			runtime.timezone = FORCED_SESSION_TIMEZONE;
		}

		return {
			adapter: "postgres",
			hostname: cfg.host,
			port: cfg.port,
			username: cfg.username,
			password: cfg.password,
			database: cfg.database,
			tls,
			connectionTimeout,
			connection: Object.keys(runtime).length ? runtime : undefined,
		};
	},

	async ping(db: SQL): Promise<DatabaseConnectionInfo> {
		const rows = (await db.unsafe(
			"SELECT version() AS version, current_database() AS db",
		)) as Array<Record<string, unknown>>;
		const version = String(rows[0]?.version ?? "");
		// "PostgreSQL 16.2 (Debian 16.2-1.pgdg120+1) on x86_64-pc-linux-gnu, …"
		const match = /^\s*PostgreSQL\s+([0-9][0-9A-Za-z.\-]*)/i.exec(version);
		return {
			productName: match ? "PostgreSQL" : "Postgres-compatible server",
			productVersion: match ? match[1] : version.trim(),
			currentDatabase: rows[0]?.db == null ? null : String(rows[0].db),
		};
	},

	quoteIdent(name: string): string {
		return `"${name.replace(/"/g, '""')}"`;
	},

	// Postgres has no cross-database reference syntax; a table is always
	// resolved inside the database the session is connected to.
	qualify(_database: string, schema: string, table: string): string {
		return schema
			? `${postgresDriver.quoteIdent(schema)}.${postgresDriver.quoteIdent(table)}`
			: postgresDriver.quoteIdent(table);
	},

	// Mirrors the reference behaviour: the same switch the reference gates on
	// `isSchemaAware(db_type)` at `ConnectionDialog.vue:9867`.
	async listSchemas(
		db: SQL,
		cfg: ConnectionConfig,
		_database: string,
	): Promise<string[]> {
		const rows = (await db.unsafe(
			cfg.showSystemSchemas
				? "SELECT schema_name FROM information_schema.schemata ORDER BY 1"
				: "SELECT schema_name FROM information_schema.schemata " +
					"WHERE schema_name NOT LIKE 'pg_%' " +
					"AND schema_name <> 'information_schema' " +
					"ORDER BY 1",
		)) as Array<Record<string, unknown>>;
		return rows.map((row) => String(row.schema_name));
	},

	async listDatabases(
		db: SQL,
		filter: string,
	): Promise<Array<{ name: string; comment: string | null }>> {
		const rows = (await db.unsafe(
			"SELECT datname AS name, shobj_description(oid, 'pg_database') AS comment " +
				"FROM pg_database " +
				"WHERE datallowconn AND NOT datistemplate " +
				"AND ($1 = '' OR datname ILIKE $1) " +
				"ORDER BY datname",
			[`%${filter}%`],
		)) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			name: String(row.name),
			comment: row.comment == null ? null : String(row.comment),
		}));
	},

	async listTables(
		db: SQL,
		_database: string,
		schema: string,
		filter: string,
	): Promise<TableInfo[]> {
		// A declarative partition is an ordinary table whose parent is a
		// partitioned one, so it would otherwise be listed beside that parent.
		// `pg_inherits` rather than `relispartition` keeps this working on 9.x,
		// where `relkind` is never `'p'` and the guard matches nothing. Plain
		// `INHERITS` children have a non-partitioned parent and stay listed.
		const rows = (await db.unsafe(
			"SELECT c.relname AS name, " +
				"c.relkind::text AS relkind, " +
				"obj_description(c.oid, 'pg_class') AS comment, " +
				"c.reltuples::bigint AS row_count " +
				"FROM pg_catalog.pg_class c " +
				"JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
				"WHERE n.nspname = $1 " +
				"AND c.relkind IN ('r', 'p', 'v', 'm', 'f') " +
				"AND NOT EXISTS ( " +
				"  SELECT 1 FROM pg_catalog.pg_inherits pi " +
				"  JOIN pg_catalog.pg_class pp ON pp.oid = pi.inhparent " +
				"  WHERE pi.inhrelid = c.oid AND pp.relkind = 'p') " +
				"AND ($2 = '' OR c.relname ILIKE $2) " +
				"ORDER BY c.relname",
			[schema, `%${filter}%`],
		)) as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			name: String(row.name),
			type: TABLE_TYPE_BY_RELKIND[String(row.relkind)] ?? String(row.relkind),
			comment: row.comment == null ? null : String(row.comment),
			rowCount: toRowCount(row.row_count),
		}));
	},

	async listColumns(
		db: SQL,
		_database: string,
		schema: string,
		table: string,
	): Promise<ColumnInfo[]> {
		const rows = (await db.unsafe(
			"SELECT a.attname AS name, " +
				"pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, " +
				"NOT a.attnotnull AS is_nullable, " +
				"COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '') AS default_value, " +
				"pg_catalog.col_description(a.attrelid, a.attnum) AS comment, " +
				"EXISTS (SELECT 1 FROM pg_catalog.pg_index i " +
				"        WHERE i.indrelid = a.attrelid AND i.indisprimary " +
				"          AND a.attnum = ANY(i.indkey)) AS is_pk, " +
				"a.attnum AS position " +
				"FROM pg_catalog.pg_attribute a " +
				"JOIN pg_catalog.pg_class c ON c.oid = a.attrelid " +
				"JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
				"LEFT JOIN pg_catalog.pg_attrdef d " +
				"       ON d.adrelid = a.attrelid AND d.adnum = a.attnum " +
				"WHERE n.nspname = $1 AND c.relname = $2 " +
				"AND a.attnum > 0 AND NOT a.attisdropped " +
				"ORDER BY a.attnum",
			[schema, table],
		)) as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			name: String(row.name),
			dataType: String(row.data_type ?? ""),
			isNullable: row.is_nullable === true,
			isPrimaryKey: row.is_pk === true,
			defaultValue:
				row.default_value === null || row.default_value === ""
					? null
					: String(row.default_value),
			comment: row.comment == null ? null : String(row.comment),
		}));
	},

	async listIndexes(
		db: SQL,
		_database: string,
		schema: string,
		table: string,
	): Promise<IndexInfo[]> {
		// One row per index column: `indkey` is unnestted with ORDINALITY so a
		// multi-column index arrives as consecutive rows that collapse into a
		// single IndexInfo below. A primary key is an ordinary `pg_index` row
		// here, so it surfaces as its own entry with `isPrimary` set.
		const rows = (await db.unsafe(
			"SELECT ic.relname AS name, " +
				"i.indisunique AS is_unique, " +
				"i.indisprimary AS is_primary, " +
				"am.amname AS method, " +
				"COALESCE(a.attname, " +
				"  pg_catalog.pg_get_indexdef(i.indexrelid, k.position::int, true)) " +
				"  AS column_name " +
				"FROM pg_catalog.pg_index i " +
				"JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid " +
				"JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid " +
				"JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace " +
				"JOIN pg_catalog.pg_am am ON am.oid = ic.relam " +
				// `indkey` is an `int2vector`, not a real array type on every
				// supported server version, so it is split through its text form
				// rather than cast straight to `int2[]`.
				"CROSS JOIN LATERAL unnest(" +
				"  string_to_array(i.indkey::text, ' ')::int2[]) " +
				"     WITH ORDINALITY AS k(attnum, position) " +
				"LEFT JOIN pg_catalog.pg_attribute a " +
				"       ON a.attrelid = i.indrelid " +
				"      AND a.attnum = k.attnum " +
				"WHERE n.nspname = $1 AND tc.relname = $2 " +
				"ORDER BY ic.relname, k.position",
			[schema, table],
		)) as Array<Record<string, unknown>>;

		const indexes: IndexInfo[] = [];
		for (const row of rows) {
			const name = String(row.name);
			// Rows arrive sorted by (name, position), so a name change is the
			// only signal that a new index starts here.
			const last = indexes[indexes.length - 1];
			if (!last || last.name !== name) {
				indexes.push({
					name,
					columns: [],
					isUnique: row.is_unique === true,
					isPrimary: row.is_primary === true,
					method: row.method == null ? null : String(row.method),
				});
			}
			// Rows arrive sorted by (name, position), so appending keeps each
			// index's columns in index order.
			if (row.column_name != null) {
				indexes[indexes.length - 1].columns.push(String(row.column_name));
			}
		}
		return indexes;
	},

	async listTriggers(
		db: SQL,
		_database: string,
		schema: string,
		table: string,
	): Promise<TriggerInfo[]> {
		// `tgtype` is a bitmask (TRIGGER_TYPE_* in the server headers): bit 1 is
		// BEFORE, bit 6 INSTEAD, bits 2/3/4/5 the four events. Testing the bits
		// in SQL keeps the trigger definition itself out of the JS layer.
		const rows = (await db.unsafe(
			"SELECT t.tgname AS name, " +
				"pg_catalog.pg_get_triggerdef(t.oid, true) AS statement, " +
				"(t.tgtype & 64) <> 0 AS is_instead, " +
				"(t.tgtype & 2) <> 0 AS is_before, " +
				"(t.tgtype & 4) <> 0 AS is_insert, " +
				"(t.tgtype & 8) <> 0 AS is_delete, " +
				"(t.tgtype & 16) <> 0 AS is_update, " +
				"(t.tgtype & 32) <> 0 AS is_truncate " +
				"FROM pg_catalog.pg_trigger t " +
				"JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid " +
				"JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
				"WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal " +
				"ORDER BY t.tgname",
			[schema, table],
		)) as Array<Record<string, unknown>>;

		return rows.map((row) => {
			const events: string[] = [];
			if (row.is_insert === true) events.push("INSERT");
			if (row.is_delete === true) events.push("DELETE");
			if (row.is_update === true) events.push("UPDATE");
			if (row.is_truncate === true) events.push("TRUNCATE");

			let timing: string | null = null;
			if (row.is_instead === true) timing = "INSTEAD OF";
			else if (row.is_before === true) timing = "BEFORE";
			else if (events.length > 0) timing = "AFTER";

			return {
				name: String(row.name),
				timing,
				// A trigger can fire on several events at once; Postgres then
				// spells it `INSERT OR UPDATE`, so join with the same word.
				event: events.length === 0 ? null : events.join(" OR "),
				statement: row.statement == null ? "" : String(row.statement),
			};
		});
	},

	async listForeignKeys(
		db: SQL,
		_database: string,
		schema: string,
		table: string,
	): Promise<ForeignKeyInfo[]> {
		// `conkey` and `confkey` are two independent attnum arrays. Unnesting
		// both without ordinality and cross-joining them would emit the full
		// product and silently mis-pair a multi-column key, so each side keeps
		// its ordinality and only equal positions are joined.
		const rows = (await db.unsafe(
			"SELECT con.conname AS name, " +
				"rn.nspname AS ref_schema, " +
				"rc.relname AS ref_table, " +
				"con.confupdtype::text AS on_update, " +
				"con.confdeltype::text AS on_delete, " +
				"a.attname AS column_name, " +
				"ra.attname AS ref_column_name, " +
				"k.position AS position " +
				"FROM pg_catalog.pg_constraint con " +
				"JOIN pg_catalog.pg_class c ON c.oid = con.conrelid " +
				"JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
				"JOIN pg_catalog.pg_class rc ON rc.oid = con.confrelid " +
				"JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace " +
				"CROSS JOIN LATERAL unnest(con.conkey) " +
				"     WITH ORDINALITY AS k(attnum, position) " +
				"CROSS JOIN LATERAL unnest(con.confkey) " +
				"     WITH ORDINALITY AS rk(ref_attnum, ref_position) " +
				"JOIN pg_catalog.pg_attribute a " +
				"  ON a.attrelid = con.conrelid AND a.attnum = k.attnum " +
				"JOIN pg_catalog.pg_attribute ra " +
				"  ON ra.attrelid = con.confrelid AND ra.attnum = rk.ref_attnum " +
				"WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2 " +
				"AND k.position = rk.ref_position " +
				"ORDER BY con.conname, k.position",
			[schema, table],
		)) as Array<Record<string, unknown>>;

		const keys: ForeignKeyInfo[] = [];
		for (const row of rows) {
			const name = String(row.name);
			const last = keys[keys.length - 1];
			if (!last || last.name !== name) {
				const refSchema = String(row.ref_schema);
				const refTable = String(row.ref_table);
				keys.push({
					name,
					columns: [],
					referencedTable:
						refSchema === schema ? refTable : `${refSchema}.${refTable}`,
					referencedColumns: [],
					onUpdate: referentialAction(row.on_update),
					onDelete: referentialAction(row.on_delete),
				});
			}
			const key = keys[keys.length - 1];
			if (row.column_name != null) key.columns.push(String(row.column_name));
			if (row.ref_column_name != null) {
				key.referencedColumns.push(String(row.ref_column_name));
			}
		}
		return keys;
	},

	async tableDdl(
		db: SQL,
		_database: string,
		schema: string,
		table: string,
	): Promise<string> {
		const relations = (await db.unsafe(
			"SELECT c.oid::bigint AS oid, c.relname AS name, c.relkind::text AS relkind, " +
				"obj_description(c.oid, 'pg_class') AS comment " +
				"FROM pg_catalog.pg_class c " +
				"JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace " +
				"WHERE n.nspname = $1 AND c.relname = $2",
			[schema, table],
		)) as Array<Record<string, unknown>>;

		const relation = relations[0];
		if (!relation) {
			throw normalizeBackendError(
				new Error(`Table "${schema}"."${table}" does not exist.`),
			);
		}
		const oid = String(relation.oid);
		const relkind = String(relation.relkind);

		const out: string[] = [];

		if (relkind === "v" || relkind === "m") {
			const views = (await db.unsafe(
				"SELECT pg_catalog.pg_get_viewdef($1::oid, true) AS def",
				[oid],
			)) as Array<Record<string, unknown>>;
			const keyword = relkind === "m" ? "MATERIALIZED VIEW" : "VIEW";
			// `pg_get_viewdef` already terminates the body with `;`, so strip it
			// before appending this module's own statement separator.
			const body = String(views[0]?.def ?? "").replace(/;\s*$/, "");
			out.push(
				`CREATE ${keyword} ${quoteQualified(schema, String(relation.name))} AS\n${body}`,
			);
			out.push(...commentStatements(String(relation.name), relation.comment));
			return out.join(";\n\n") + ";";
		}

		const columns = (await db.unsafe(
			"SELECT a.attname AS name, " +
				"pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, " +
				"a.attnotnull AS not_null, " +
				"a.attidentity::text AS identity, " +
				"a.attgenerated::text AS generated, " +
				"pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_value, " +
				"pg_catalog.col_description(a.attrelid, a.attnum) AS comment " +
				"FROM pg_catalog.pg_attribute a " +
				"LEFT JOIN pg_catalog.pg_attrdef d " +
				"       ON d.adrelid = a.attrelid AND d.adnum = a.attnum " +
				"WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped " +
				"ORDER BY a.attnum",
			[oid],
		)) as Array<Record<string, unknown>>;

		const constraints = (await db.unsafe(
			"SELECT con.conname AS name, " +
				"pg_catalog.pg_get_constraintdef(con.oid) AS def " +
				"FROM pg_catalog.pg_constraint con " +
				"WHERE con.conrelid = $1::oid AND con.contype IN ('p', 'u', 'f', 'c') " +
				"ORDER BY con.contype, con.conname",
			[oid],
		)) as Array<Record<string, unknown>>;

		let partitionKey: string | null = null;
		if (relkind === "p") {
			const keyRows = (await db.unsafe(
				"SELECT pg_catalog.pg_get_partkeydef($1::oid) AS def",
				[oid],
			)) as Array<Record<string, unknown>>;
			partitionKey = keyRows[0]?.def == null ? null : String(keyRows[0].def);
		}

		if (relkind === "f") {
			out.push(
				`-- Foreign table ${schema}.${String(relation.name)}; ` +
					"its server definition lives on the remote database.",
			);
		}

		const body: string[] = columns.map((column) =>
			columnDefinition(column),
		);
		for (const constraint of constraints) {
			body.push(
				`CONSTRAINT ${quoteIdent(String(constraint.name))} ${String(constraint.def)}`,
			);
		}

		out.push(
			`CREATE TABLE ${quoteQualified(schema, String(relation.name))} (\n` +
				`  ${body.join(",\n  ")}\n` +
				(partitionKey ? `) ${partitionKey}` : ")"),
		);

		out.push(...commentStatements(String(relation.name), relation.comment));
		for (const column of columns) {
			out.push(...commentStatements(String(column.name), column.comment, schema, String(relation.name)));
		}

		return out.join(";\n\n") + ";";
	},

	async columnTypes(
		db: SQL,
		sql: string,
		columns: string[],
	): Promise<string[]> {
		if (columns.length === 0 || !isReadStatement(sql)) return [];
		try {
			const rows = (await db.unsafe(
				wrapForColumnTypeProbePlanOnly(sql, columns),
			)) as unknown;
			if (!Array.isArray(rows) || rows.length === 0) return [];
			const first = rows[0];
			if (first === null || typeof first !== "object" || Array.isArray(first)) {
				return [];
			}
			const row = first as Record<string, unknown>;
			// One alias per column, so the answer cannot drift out of order.
			return columns.map((column) => {
				const value = row[column];
				return value == null ? "" : String(value);
			});
		} catch {
			return [];
		}
	},
};

/**
 * `pg_constraint.confupdtype` / `confdeltype` store a single character, and
 * a blank one means "not specified" rather than `NO ACTION` — the server only
 * writes `a` when the clause is actually present. Both cases are mapped to the
 * SQL spelling, with the blank one staying null so the UI can tell them apart.
 */
const REFERENTIAL_ACTIONS: Record<string, string> = {
	a: "NO ACTION",
	r: "RESTRICT",
	c: "CASCADE",
	n: "SET NULL",
	d: "SET DEFAULT",
};

function referentialAction(value: unknown): string | null {
	if (value == null) return null;
	return REFERENTIAL_ACTIONS[String(value)] ?? null;
}

/**
 * `reltuples` is a float estimate and is -1 until the relation has been
 * analyzed or vacuumed. That sentinel means "unknown" and must never surface
 * as a row count. NULL and "" are guarded as well, since `Number(null)` is 0
 * and would read as an empty relation.
 */
function toRowCount(value: unknown): number | null {
	if (value == null || value === "") return null;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	return Math.round(parsed);
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function quoteQualified(schema: string, table: string): string {
	return schema
		? `${quoteIdent(schema)}.${quoteIdent(table)}`
		: quoteIdent(table);
}

function columnDefinition(column: Record<string, unknown>): string {
	const parts = [`${quoteIdent(String(column.name))} ${String(column.data_type)}`];
	if (column.generated === "s") {
		parts.push(`GENERATED ALWAYS AS (${String(column.default_value)}) STORED`);
	} else if (column.identity === "a") {
		parts.push("GENERATED ALWAYS AS IDENTITY");
	} else if (column.identity === "d") {
		parts.push("GENERATED BY DEFAULT AS IDENTITY");
	} else if (column.default_value != null) {
		parts.push(`DEFAULT ${String(column.default_value)}`);
	}
	if (column.not_null === true) parts.push("NOT NULL");
	return parts.join(" ");
}

function commentStatements(
	name: string,
	comment: unknown,
	schema?: string,
	table?: string,
): string[] {
	if (comment == null || comment === "") return [];
	const literal = `'${String(comment).replace(/'/g, "''")}'`;
	if (schema !== undefined && table !== undefined) {
		return [
			`COMMENT ON COLUMN ${quoteQualified(schema, table)}.${quoteIdent(name)} IS ${literal}`,
		];
	}
	return [`COMMENT ON TABLE ${quoteIdent(name)} IS ${literal}`];
}