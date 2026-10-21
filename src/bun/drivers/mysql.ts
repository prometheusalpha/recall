import type { SQL } from "bun";
import type {
	ColumnInfo,
	DatabaseConnectionInfo,
	ExplainPlan,
	ExplainPlanNode,
	ForeignKeyInfo,
	IndexInfo,
	SqlConnectionConfig,
	TableInfo,
	TriggerInfo,
} from "../../shared/types";
import type { Driver, SQLOptions } from "../driver";
import {
	alreadyExplains,
	normalizeBackendError,
	parsePlanJson,
	parseUrlParams,
	planArray,
	planObject,
	planText,
} from "../driver";

/**
 * `ConnectionConfig.urlParams` handling for MySQL: TLS flags map onto Bun.SQL
 * options, `charset` is negotiated by Bun itself, and anything else is
 * forwarded verbatim as a connection URL query parameter (e.g. `socket=…`).
 */
const MYSQL_TLS_PARAMS: Record<string, "ssl" | "tls"> = {
	ssl: "ssl",
	"ssl-mode": "ssl",
	sslmode: "ssl",
	tls: "tls",
};

/** Parameters Bun negotiates itself; forwarding them would be a no-op. */
const MYSQL_IGNORED_PARAMS: Record<string, true> = { charset: true };

const SYSTEM_SCHEMAS = ["information_schema", "mysql", "performance_schema", "sys"];

const TABLE_TYPE_BY_VALUE: Record<string, string> = {
	"BASE TABLE": "table",
	VIEW: "view",
	"SYSTEM VIEW": "view",
};

export const mysqlDriver: Driver = {
	dbType: "mysql",
	databaseScoped: false,

	buildOptions(cfg: SqlConnectionConfig): SQLOptions {
		const options: SQL.PostgresOrMySQLOptions = {
			adapter: "mysql",
			hostname: cfg.host,
			port: cfg.port,
			username: cfg.username,
			password: cfg.password,
		};
		// An empty Database field means "no default schema", not "the schema
		// called mysql". Passing `database: ""` lets the connector fall back to
		// its own default, which is the server's `mysql` system schema — and
		// every app account is denied access to it, so the profile failed with
		// `Access denied for user '…' to database 'mysql'` even though the user
		// never asked for that database. Leaving the key out connects with no
		// default schema, which is what the tree needs anyway: it lists
		// databases explicitly rather than reading the session's current one.
		const database = cfg.database.trim();
		if (database) options.database = database;

		for (const [key, value] of parseUrlParams(cfg.urlParams)) {
			const tlsOption = MYSQL_TLS_PARAMS[key];
			if (tlsOption !== undefined) {
				options[tlsOption] = parseTlsFlag(value);
			} else if (!MYSQL_IGNORED_PARAMS[key]) {
				appendUrlParam(options, key, value);
			}
		}

		if (cfg.ssl && options.ssl === undefined && options.tls === undefined) {
			options.ssl = true;
		}

		return options;
	},

	async ping(db: SQL): Promise<DatabaseConnectionInfo> {
		const rows = (await db.unsafe(
			"SELECT VERSION() AS version, DATABASE() AS db",
		)) as Array<Record<string, unknown>>;
		const version = String(rows[0]?.version ?? "");
		return {
			productName: /mariadb/i.test(version)
				? "MariaDB"
				: /percona/i.test(version)
					? "Percona Server"
					: "MySQL",
			productVersion: version.trim(),
			currentDatabase: rows[0]?.db == null ? null : String(rows[0].db),
		};
	},

	quoteIdent(name: string): string {
		return `\`${name.replace(/`/g, "``")}\``;
	},

	// For MySQL a "schema" *is* a database, so qualification uses it as such.
	qualify(_database: string, schema: string, table: string): string {
		return schema
			? `${mysqlDriver.quoteIdent(schema)}.${mysqlDriver.quoteIdent(table)}`
			: mysqlDriver.quoteIdent(table);
	},

	// MySQL has no schemas below databases: `schema` is the database itself, so
	// the schema level of the tree is empty and the database level is populated
	// by `listDatabases`. MySQL is therefore not schema-aware in this model and
	// `ConnectionConfig.showSystemSchemas` is deliberately ignored here; the
	// system-schema exclusion always applies, as it does below.
	async listSchemas(): Promise<string[]> {
		return [];
	},

	async listDatabases(
		db: SQL,
		filter: string,
	): Promise<Array<{ name: string; comment: string | null }>> {
		// SYSTEM_SCHEMAS is a module-level literal: no config, env or user input
		// can reach it, so its members are bound as parameters rather than
		// spliced into the SQL text.
		const excluded = SYSTEM_SCHEMAS.map(() => "?").join(", ");
		const rows = (await db.unsafe(
			"SELECT s.schema_name AS name, '' AS comment " +
				"FROM information_schema.schemata s " +
				`WHERE s.schema_name NOT IN (${excluded}) ` +
				"AND (? = '' OR s.schema_name LIKE ?) " +
				"ORDER BY s.schema_name",
			[...SYSTEM_SCHEMAS, filter, `%${filter}%`],
		)) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			name: String(row.name),
			comment: row.comment == null || row.comment === "" ? null : String(row.comment),
		}));
	},

	async listTables(
		db: SQL,
		_database: string,
		schema: string,
		filter: string,
	): Promise<TableInfo[]> {
		const rows = (await db.unsafe(
			"SELECT t.table_name AS name, t.table_type AS type, " +
				"t.table_comment AS comment, t.table_rows AS row_count " +
				"FROM information_schema.tables t " +
				"WHERE t.table_schema = ? " +
				"AND (? = '' OR t.table_name LIKE ?) " +
				"ORDER BY t.table_name",
			[schema, filter, `%${filter}%`],
		)) as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			name: String(row.name),
			type: TABLE_TYPE_BY_VALUE[String(row.type)] ?? String(row.type ?? ""),
			comment: row.comment == null || row.comment === "" ? null : String(row.comment),
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
			"SELECT c.column_name AS name, c.column_type AS data_type, " +
				"c.is_nullable AS is_nullable, c.column_default AS default_value, " +
				"c.column_comment AS comment, c.extra AS extra, " +
				"c.generation_expression AS generation_expression, " +
				"EXISTS (SELECT 1 FROM information_schema.statistics s " +
				"        WHERE s.table_schema = c.table_schema " +
				"          AND s.table_name = c.table_name " +
				"          AND s.column_name = c.column_name " +
				"          AND s.index_name = 'PRIMARY') AS is_pk, " +
				"c.ordinal_position AS position " +
				"FROM information_schema.columns c " +
				"WHERE c.table_schema = ? AND c.table_name = ? " +
				"ORDER BY c.ordinal_position",
			[schema, table],
		)) as Array<Record<string, unknown>>;

		return rows.map((row) => ({
			name: String(row.name),
			dataType: String(row.data_type ?? ""),
			isNullable: String(row.is_nullable ?? "").toUpperCase() === "YES",
			// MySQL has no boolean result type: EXISTS yields the integer 1/0,
			// so a strict `=== true` test would report every column as
			// non-primary. Normalize both shapes.
			isPrimaryKey: toBool(row.is_pk),
			defaultValue:
				row.default_value == null ? null : String(row.default_value),
			comment: row.comment == null || row.comment === "" ? null : String(row.comment),
			ddl: addColumnDdl(schema, table, row),
		}));
	},

	async listIndexes(
		db: SQL,
		_database: string,
		schema: string,
		table: string,
	): Promise<IndexInfo[]> {
		// `statistics` holds one row per index column, so `seq_in_index` gives
		// both the ordering and the grouping key. SYSTEM_SCHEMAS is a
		// module-level literal, so its members are bound as parameters exactly
		// as `listDatabases` does.
		const excluded = SYSTEM_SCHEMAS.map(() => "?").join(", ");
		const rows = (await db.unsafe(
			"SELECT s.index_name AS name, s.column_name AS column_name, " +
				"s.non_unique AS non_unique, s.index_type AS method " +
				"FROM information_schema.statistics s " +
				"WHERE s.table_schema = ? AND s.table_name = ? " +
				`AND s.table_schema NOT IN (${excluded}) ` +
				"ORDER BY s.index_name, s.seq_in_index",
			[schema, table, ...SYSTEM_SCHEMAS],
		)) as Array<Record<string, unknown>>;

		// The key list of an index is only complete once every row of it has
		// been folded in, and MySQL has no catalog function that prints an index
		// back the way Postgres's `pg_get_indexdef` does, so the statement is
		// composed at the end rather than as each index is opened.
		const indexes: Array<Omit<IndexInfo, "ddl">> = [];
		for (const row of rows) {
			const name = String(row.name);
			// Sorted by (index_name, seq_in_index), so a name change marks the
			// start of the next index.
			const last = indexes[indexes.length - 1];
			if (!last || last.name !== name) {
				indexes.push({
					name,
					columns: [],
					// MySQL spells this the other way round: 0 means unique.
					isUnique: !toBool(row.non_unique),
					isPrimary: name === "PRIMARY",
					// `index_type` arrives uppercase (`BTREE`, `HASH`,
					// `FULLTEXT`, `SPATIAL`); lowercasing matches the catalog
					// spelling Postgres reports through `pg_am`.
					method:
						row.method == null ? null : String(row.method).toLowerCase(),
					// MySQL has no partial indexes; the field exists so both
					// drivers answer the same shape.
					condition: null,
				});
			}
			// Rows are sorted by (index_name, seq_in_index), so appending keeps
			// each index's columns in index order.
			if (row.column_name != null) {
				indexes[indexes.length - 1].columns.push(String(row.column_name));
			}
		}
		return indexes.map((index) => ({
			...index,
			ddl: indexDdl(schema, table, index),
		}));
	},

	async listTriggers(
		db: SQL,
		_database: string,
		schema: string,
		table: string,
	): Promise<TriggerInfo[]> {
		const excluded = SYSTEM_SCHEMAS.map(() => "?").join(", ");
		const rows = (await db.unsafe(
			"SELECT t.trigger_name AS name, t.action_timing AS timing, " +
				"t.event_manipulation AS event, t.action_statement AS statement " +
				"FROM information_schema.triggers t " +
				"WHERE t.trigger_schema = ? AND t.event_object_table = ? " +
				`AND t.trigger_schema NOT IN (${excluded}) ` +
				"ORDER BY t.trigger_name",
			[schema, table, ...SYSTEM_SCHEMAS],
		)) as Array<Record<string, unknown>>;

		// A multi-statement trigger body yields several rows for one trigger,
		// so rows are grouped by name and their bodies concatenated rather than
		// emitting one trigger per body statement.
		const triggers: TriggerInfo[] = [];
		for (const row of rows) {
			const name = String(row.name);
			const statement = row.statement == null ? "" : String(row.statement);
			const last = triggers[triggers.length - 1];
			if (last && last.name === name) {
				if (statement !== "" && !last.statement.includes(statement)) {
					last.statement =
						last.statement === "" ? statement : `${last.statement};\n${statement}`;
				}
				continue;
			}
			triggers.push({
				name,
				// MySQL does report timing (`action_timing`): always BEFORE or
				// AFTER, never INSTEAD OF.
				timing: row.timing == null ? null : String(row.timing),
				event: row.event == null ? null : String(row.event),
				statement,
			});
		}
		return triggers;
	},

	async listForeignKeys(
		db: SQL,
		_database: string,
		schema: string,
		table: string,
	): Promise<ForeignKeyInfo[]> {
		// `referential_constraints` is unique per constraint and carries the
		// rules; `key_column_usage` carries one ordered row per key column, so
		// `ordinal_position` is what pairs a column with its target column.
		const excluded = SYSTEM_SCHEMAS.map(() => "?").join(", ");
		const rows = (await db.unsafe(
			"SELECT k.constraint_name AS name, k.column_name AS column_name, " +
				"k.referenced_table_schema AS ref_schema, " +
				"k.referenced_table_name AS ref_table, " +
				"k.referenced_column_name AS ref_column_name, " +
				"r.update_rule AS on_update, r.delete_rule AS on_delete " +
				"FROM information_schema.key_column_usage k " +
				"JOIN information_schema.referential_constraints r " +
				"  ON r.constraint_schema = k.constraint_schema " +
				" AND r.constraint_name = k.constraint_name " +
				" AND r.table_name = k.table_name " +
				"WHERE k.table_schema = ? AND k.table_name = ? " +
				"AND k.referenced_table_name IS NOT NULL " +
				`AND k.table_schema NOT IN (${excluded}) ` +
				"ORDER BY k.constraint_name, k.ordinal_position",
			[schema, table, ...SYSTEM_SCHEMAS],
		)) as Array<Record<string, unknown>>;

		const keys: ForeignKeyInfo[] = [];
		for (const row of rows) {
			const name = String(row.name);
			const last = keys[keys.length - 1];
			if (!last || last.name !== name) {
				const refSchema = String(row.ref_schema ?? "");
				const refTable = String(row.ref_table ?? "");
				keys.push({
					name,
					columns: [],
					referencedTable:
						refSchema === "" || refSchema === schema
							? refTable
							: `${refSchema}.${refTable}`,
					referencedColumns: [],
					onUpdate: referentialRule(row.on_update),
					onDelete: referentialRule(row.on_delete),
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
		const rows = (await db.unsafe(
			`SHOW CREATE TABLE ${mysqlDriver.qualify("", schema, table)}`,
		)) as Array<Record<string, unknown>>;
		const row = rows[0];
		if (!row) {
			throw normalizeBackendError(
				new Error(`Table \`${schema}\`.\`${table}\` does not exist.`),
			);
		}
		// `SHOW CREATE TABLE` labels its result `Create Table` for tables but
		// `Create View` for views, so both keys have to be accepted or a view
		// yields an empty definition.
		const createStatement = Object.entries(row)
			.map(([key, value]) => [
				key.toLowerCase().replace(/\s+/g, ""),
				value,
			] as const)
			.find(([key]) => key === "createtable" || key === "createview")?.[1];
		return createStatement == null ? "" : String(createStatement);
	},

	/**
	 * MySQL exposes no per-result column metadata on a plain query, and unlike
	 * Postgres there is no `pg_typeof` equivalent to evaluate against the user's
	 * statement. Reporting `[]` sends the caller back to deriving the type from
	 * the values, which is the pre-existing behaviour.
	 */
	async columnTypes(): Promise<string[]> {
		return [];
	},

	async explain(db: SQL, sql: string): Promise<ExplainPlan> {
		const statement = alreadyExplains(sql)
			? sql
			: `EXPLAIN FORMAT=JSON ${sql}`;
		const rows = (await db.unsafe(statement)) as Array<
			Record<string, unknown>
		>;
		// MySQL answers with the plan as a JSON *string* in one column, where
		// Postgres hands back an already decoded `json` column.
		const raw = parsePlanJson(Object.values(rows[0] ?? {})[0]);
		return { sql: statement, raw, nodes: parseMysqlPlan(raw) };
	},
};

/**
 * MySQL has no boolean result type, so `EXISTS`/`IF`/`TRUE` all arrive as the
 * integers 1 and 0. Accept every falsy/truthy spelling a driver can hand back
 * rather than assuming the value is a JS boolean.
 */
function toBool(value: unknown): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "bigint") return value !== 0n;
	if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
	return false;
}

/**
 * `referential_constraints.update_rule` / `delete_rule` already arrive as SQL
 * keywords, so only the casing is normalized to match the Postgres spelling;
 * an empty rule means the constraint did not specify one and stays null.
 */
function referentialRule(value: unknown): string | null {
	if (value == null) return null;
	const rule = String(value).trim().toUpperCase();
	return rule === "" ? null : rule;
}


/**
 * The statement that would rebuild one index. MySQL has no catalog function
 * that prints an index back the way Postgres's `pg_get_indexdef` does, so it is
 * composed from what `information_schema.statistics` reported. Two spellings
 * need care: a primary key is only expressible as a table constraint, and
 * FULLTEXT/SPATIAL are index kinds rather than `USING` options. `USING HASH` is
 * the one access method worth naming, because BTREE is every engine's default.
 */
function indexDdl(
	schema: string,
	table: string,
	index: Omit<IndexInfo, "ddl">,
): string {
	const target = mysqlDriver.qualify("", schema, table);
	const keyList = index.columns
		.map((column) => mysqlDriver.quoteIdent(column))
		.join(", ");
	if (index.isPrimary) {
		return `ALTER TABLE ${target} ADD PRIMARY KEY (${keyList})`;
	}
	const kind =
		index.method === "fulltext"
			? "FULLTEXT "
			: index.method === "spatial"
				? "SPATIAL "
				: index.isUnique
					? "UNIQUE "
					: "";
	const using = index.method === "hash" ? " USING HASH" : "";
	return `CREATE ${kind}INDEX ${mysqlDriver.quoteIdent(index.name)} ON ${target} (${keyList})${using}`;
}

/**
 * `ALTER TABLE … ADD COLUMN` composed from `information_schema.columns`.
 * `column_default` is ambiguous: MySQL 8 reports a literal unquoted and flags
 * an expression with `DEFAULT_GENERATED`, while MariaDB already quotes its
 * literals. So a leading quote is kept as-is, an expression is wrapped in
 * parens (bare for the CURRENT_TIMESTAMP family, which MySQL 5.7 rejects in
 * parens), and anything else is quoted, which MySQL coerces for numbers too.
 */
function addColumnDdl(
	schema: string,
	table: string,
	row: Record<string, unknown>,
): string {
	const extra = String(row.extra ?? "");
	const parts = [
		`${mysqlDriver.quoteIdent(String(row.name))} ${String(row.data_type)}`,
	];
	const generated = /\b(VIRTUAL|STORED) GENERATED\b/i.exec(extra);
	if (generated && row.generation_expression) {
		parts.push(
			`GENERATED ALWAYS AS (${String(row.generation_expression)}) ${generated[1].toUpperCase()}`,
		);
	}
	parts.push(
		String(row.is_nullable ?? "").toUpperCase() === "YES" ? "NULL" : "NOT NULL",
	);
	const fallback = row.default_value == null ? null : String(row.default_value);
	if (fallback !== null && fallback.toUpperCase() !== "NULL" && !generated) {
		if (fallback.startsWith("'")) {
			parts.push(`DEFAULT ${fallback}`);
		} else if (/^current_timestamp(\(\d*\))?$/i.test(fallback)) {
			parts.push(`DEFAULT ${fallback}`);
		} else if (/DEFAULT_GENERATED/i.test(extra)) {
			parts.push(`DEFAULT (${fallback})`);
		} else {
			parts.push(`DEFAULT '${fallback.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`);
		}
	}
	if (/auto_increment/i.test(extra)) parts.push("AUTO_INCREMENT");
	const onUpdate = /on update (\S+)/i.exec(extra);
	if (onUpdate) parts.push(`ON UPDATE ${onUpdate[1]}`);
	if (row.comment != null && row.comment !== "") {
		const comment = String(row.comment)
			.replace(/\\/g, "\\\\")
			.replace(/'/g, "''");
		parts.push(`COMMENT '${comment}'`);
	}
	const target = mysqlDriver.qualify("", schema, table);
	return `ALTER TABLE ${target} ADD COLUMN ${parts.join(" ")};`;
}

type TlsOption = SQL.PostgresOrMySQLOptions["tls"];
/**
 * `information_schema.tables.table_rows` is an engine estimate that is NULL
 * whenever the engine has no cheap figure (views, and InnoDB tables that have
 * never been analyzed). NULL means "unknown" and must not collapse to 0, which
 * `Number(null)` would otherwise produce and read as an empty table.
 */
function toRowCount(value: unknown): number | null {
	if (value == null || value === "") return null;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	return Math.round(parsed);
}

const MYSQL_TLS_TRUE = ["1", "true", "yes", "on"];
const MYSQL_TLS_MODES = ["require", "verify-ca", "verify-full"] as const;

function parseTlsFlag(value: string): TlsOption {
	const normalized = value.trim().toLowerCase();
	if ((MYSQL_TLS_MODES as readonly string[]).includes(normalized)) {
		return normalized as TlsOption;
	}
	return MYSQL_TLS_TRUE.includes(normalized);
}

/**
 * Fold an unrecognised URL parameter into the `url` option so Bun's MySQL
 * connector still applies it (charset, socket path, connect attributes…).
 */
function appendUrlParam(
	options: SQL.PostgresOrMySQLOptions,
	key: string,
	value: string,
): void {
	const params = new URLSearchParams(
		options.url ? new URL(options.url).search : "",
	);
	params.set(key, value);
	const url = new URL(`mysql://${options.hostname ?? "localhost"}`);
	url.search = params.toString();
	options.url = url.toString();
}

/**
 * The parsed plan, in the shape the viewer's `ExplainPlanNode` expects.
 *
 * MySQL answers in one of two documents and does not let the caller choose:
 * the original `query_block` one, and the `query_plan` tree of `inputs` that
 * newer servers emit for plans they can describe that way (`json_schema_version`
 * is what tells them apart). Both are read, because which one arrives is the
 * server's decision rather than a setting.
 */
function parseMysqlPlan(raw: unknown): ExplainPlanNode[] {
	const root = planObject(raw);
	if (root === null) return [];
	const tree = planObject(root.query_plan);
	if (tree !== null) return [parseMysqlPlanTree(tree, "0")];
	return [parseMysqlBlock(planObject(root.query_block) ?? root, "0", "query_block")];
}

/**
 * One node of the `query_plan` shape: either a step that wraps `inputs`, or a
 * table access, which is the same record without them. `operation` is the
 * server's own sentence for the step ("Nested loop inner join", "Sort: …"), so
 * it is what the row is labelled with, while `access_type` stays the short
 * word the badge and the canvas colour are chosen from.
 */
function parseMysqlPlanTree(
	node: Record<string, unknown>,
	id: string,
): ExplainPlanNode {
	const operation = planText(node.operation);
	const accessType = planText(node.access_type);
	const relation = planText(node.table_name);
	const condition =
		planText(node.attached_condition) ?? planText(node.lookup_condition);
	const columns = planArray(node.used_columns)?.map(String).join(", ");
	const sortFields = planArray(node.sort_fields)?.map(String).join(", ");
	return {
		id,
		title:
			operation ??
			(relation ? `${accessType ?? "table"} on ${relation}` : accessType ?? "step"),
		nodeType: accessType ?? operation ?? "step",
		relation,
		index: planText(node.index_name),
		cost: planText(node.estimated_total_cost),
		rows: planText(node.estimated_rows),
		details: [
			condition ? `Condition: ${condition}` : "",
			columns ? `Columns: ${columns}` : "",
			sortFields ? `Sort: ${sortFields}` : "",
		].filter((detail) => detail !== ""),
		children: (planArray(node.inputs) ?? [])
			.map((input, index) =>
				parseMysqlPlanTree(planObject(input) ?? {}, `${id}.${index}`),
			),
	};
}

function parseMysqlBlock(
	block: Record<string, unknown>,
	id: string,
	nodeType: string,
): ExplainPlanNode {
	const children: ExplainPlanNode[] = [];

	const table = planObject(block.table);
	if (table !== null) children.push(parseMysqlTable(table, `${id}.0`));

	for (const item of planArray(block.nested_loop) ?? []) {
		const step = planObject(item);
		if (step === null) continue;
		const nestedTable = planObject(step.table);
		children.push(
			nestedTable !== null
				? parseMysqlTable(nestedTable, `${id}.${children.length}`)
				: parseMysqlBlock(step, `${id}.${children.length}`, "operation"),
		);
	}

	// Each of these wraps the block it describes rather than being part of it,
	// so it becomes a parent node instead of a detail on the node below.
	for (const key of [
		"ordering_operation",
		"grouping_operation",
		"duplicates_removal",
		"union_result",
		"materialized_from_subquery",
	]) {
		const child = planObject(block[key]);
		if (child !== null) {
			children.push(parseMysqlBlock(child, `${id}.${children.length}`, key));
		}
	}

	const message = planText(block.message);
	const selectId = planText(block.select_id);
	return {
		id,
		title: nodeType,
		nodeType,
		cost: planText(planObject(block.cost_info)?.query_cost),
		// A block reports no row estimate of its own; the tables underneath it
		// do. `select_id` is an identifier, so it reads as a detail instead.
		details: [
			message ?? "",
			selectId !== undefined ? `Select: ${selectId}` : "",
		].filter((detail) => detail !== ""),
		children,
	};
}

/** One table access: the only MySQL node with a real row estimate. */
function parseMysqlTable(
	table: Record<string, unknown>,
	id: string,
): ExplainPlanNode {
	const relation = planText(table.table_name);
	const accessType = planText(table.access_type) ?? "table";
	const costInfo = planObject(table.cost_info);
	const condition = planText(table.attached_condition);
	const columns = planArray(table.used_columns)?.map(String).join(", ");
	return {
		id,
		title: relation ? `${accessType} on ${relation}` : accessType,
		nodeType: accessType,
		relation,
		index: planText(table.key),
		cost:
			planText(costInfo?.query_cost) ??
			planText(costInfo?.read_cost) ??
			planText(costInfo?.eval_cost),
		rows:
			planText(table.rows_examined_per_scan) ??
			planText(table.rows_produced_per_join),
		details: [
			condition ? `Condition: ${condition}` : "",
			columns ? `Columns: ${columns}` : "",
			table.using_index === true ? "Using index" : "",
		].filter((detail) => detail !== ""),
		children: [],
	};
}
