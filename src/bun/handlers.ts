import { SQL } from "bun";
import { join } from "node:path";
import type { Bookmark } from "../shared/bookmark";
import type { BunRequests } from "../shared/rpc";
import type {
	ConnectionConfig,
	ConnectionTestResult,
	ExecuteResult,
	StatementResult,
} from "../shared/types";
import type { Driver } from "./driver";
import {
	columnTypeName,
	driverFor,
	normalizeBackendError,
	probeStatementColumns,
	splitStatements,
	toJsonSafe,
} from "./driver";
import {
	closeConnection,
	forgetCredential as forgetStoredCredential,
	getConnection,
	getServerConnection,
	loadCredential,
	openConnection,
	saveCredential,
} from "./connectionPool";
import {
	createSqlEntry,
	deleteSqlEntry,
	listSqlFiles,
	readSqlFile,
	renameSqlEntry,
	transferSqlEntries,
	writeSqlFile,
} from "./sqlFiles";
import {
	listConnections as listStoredConnections,
	saveConnections as saveStoredConnections,
} from "./connectionStore";
import {
	clearBookmark as clearStoredBookmark,
	listBookmarks as listStoredBookmarks,
	resolveBookmark as resolveStoredBookmark,
	saveBookmark as saveStoredBookmark,
} from "./bookmarkStore";
type Params<K extends keyof BunRequests> = BunRequests[K]["params"];

/** Re-exported so `rpc.ts` can forward the push without importing the pool. */
export { onConnectionLost as onConnectionLostEmitter } from "./connectionPool";

/**
 * Per-statement progress push. Set by `rpc.ts`, which owns the transport;
 * declared here as a plain callback so the handlers stay transport-free.
 */
type ProgressEmitter = (payload: {
	executionId: string;
	statementIndex: number;
	completed: number;
	total: number;
	executionTimeMs: number;
	affectedRows: number;
}) => void;

let emitProgress: ProgressEmitter | null = null;

export function setProgressEmitter(emitter: ProgressEmitter | null): void {
	emitProgress = emitter;
}

async function closeQuietly(db: SQL): Promise<void> {
	try {
		await db.close({ timeout: 1 });
	} catch {
		// The handle is already unusable; nothing left to release.
	}
}

/** In-flight queries, keyed by the renderer-supplied execution id. */
const executions = new Map<string, { cancel(): void }>();

/** Execution ids the renderer has cancelled, so a batch can stop mid-way. */
const cancelledExecutions = new Set<string>();

/**
 * Bun attaches `command` and `count` as extra properties on the array a query
 * resolves to. Postgres reports the affected row count in `count` (its
 * `affectedRows` is null); MySQL reports it in `affectedRows`. `in` narrowing
 * reads them without asserting a shape on external data.
 */
function readResultMeta(result: unknown[]): {
	command: string | null;
	count: number | null;
} {
	const command =
		"command" in result && typeof result.command === "string"
			? result.command
			: null;
	// The two dialects disagree about where the affected row count lives:
	// Postgres fills `count` and leaves `affectedRows` null; MySQL is the
	// reverse, leaving `count` at a meaningless 0. Take whichever is actually a
	// number, checking `affectedRows` first so MySQL's `count: 0` placeholder
	// cannot mask the real value.
	let count: number | null = null;
	if ("affectedRows" in result) {
		const affected = result.affectedRows;
		if (typeof affected === "number") count = affected;
		else if (typeof affected === "bigint") count = Number(affected);
	}
	if (count === null && "count" in result && typeof result.count === "number") {
		count = result.count;
	}
	return { command, count };
}

/**
 * Run one statement and shape it into a `StatementResult`.
 *
 * Never throws for a database-reported SQL error: the error is captured in
 * `StatementResult.error` so the grid can render it inline. The query handle is
 * registered for the duration so `cancelQuery` can interrupt it, and is always
 * awaited inside the try so a rejection cannot escape unhandled.
 *
 * Runs once per statement in object mode: `Bun.SQL` exposes rows but no result
 * metadata, so an object's keys are the only portable source of column names.
 */
async function runStatement(
	db: SQL,
	driver: Driver,
	statement: string,
	statementIndex: number,
	maxRows: number,
	executionId: string,
): Promise<StatementResult> {
	const startedAt = performance.now();
	const shell = (
		rows: unknown[][],
		columns: string[],
		affectedRows: number,
		declaredTypes: string[] = [],
	): StatementResult => ({
		statementIndex,
		sql: statement,
		columns,
		// A server-declared type wins; a column the probe could not type falls
		// back to what its values look like.
		columnTypes: columns.map(
			(_, index) =>
				declaredTypes[index] ||
				columnTypeName(rows.find((row) => row[index] !== null)?.[index]),
		),
		rows,
		affectedRows,
		executionTimeMs: performance.now() - startedAt,
		truncated: false,
		error: null,
	});

	const query = db.unsafe(statement);
	executions.set(executionId, query);

	let fetched: unknown;
	try {
		fetched = await query;
	} catch (error) {
		return {
			statementIndex,
			sql: statement,
			columns: [],
			columnTypes: [],
			rows: [],
			affectedRows: 0,
			executionTimeMs: performance.now() - startedAt,
			truncated: false,
			error: normalizeBackendError(error, statement),
		};
	} finally {
		if (executions.get(executionId) === query) executions.delete(executionId);
	}

	if (!Array.isArray(fetched)) {
		return shell([], [], 0);
	}

	const records = fetched as Array<Record<string, unknown>>;
	// A read with no rows still needs headers; the probe plans the statement and
	// yields its column names without running the body a second time.
	const columns =
		records.length > 0
			? Object.keys(records[0])
			: await probeStatementColumns(db, statement);
	// The declared type is asked of the server: a value-derived type calls both
	// `timestamptz` and `timestamp without time zone` a `Date`, and only the
	// first is an instant the grid may re-render into the display timezone. An
	// empty probe answer falls back to the old value-derived guess.
	const declaredTypes = await driver.columnTypes(db, statement, columns);
	const capped = maxRows > 0 ? records.slice(0, maxRows) : records;
	const rows = capped.map((record) =>
		columns.map((column) => toJsonSafe(record[column])),
	);

	return {
		...shell(
			rows,
			columns,
			readResultMeta(fetched).count ?? rows.length,
			declaredTypes,
		),
		truncated: records.length > capped.length,
	};
}

/**
 * Fill in a password the renderer no longer holds.
 *
 * Bun owns credential storage (see `./credentialStore`), so a profile with
 * `savePassword` reconnects after an app restart with an empty
 * `config.password` — the renderer deliberately never persists it. When no
 * stored secret exists the config is returned untouched and the connection
 * attempt fails with the server's own auth error, which is the honest outcome.
 */
async function withStoredPassword(
	config: ConnectionConfig,
): Promise<ConnectionConfig> {
	if (config.password || !config.savePassword) return config;
	const stored = await loadCredential(config.id, config.username);
	return stored ? { ...config, password: stored } : config;
}


export const handlers = {
	/**
	 * Profile persistence. SQLite holds the list (`./connectionStore`); this is
	 * only the transport, so the renderer never touches the file itself.
	 */
	listConnections(): ConnectionConfig[] {
		return listStoredConnections();
	},

	saveConnections({ configs }: Params<"saveConnections">): void {
		saveStoredConnections(configs);
	},

	async testConnection({ config }: Params<"testConnection">) {
		const result: ConnectionTestResult = {
			ok: false,
			message: "",
			databaseInfo: null,
			databases: [],
			schemas: [],
		};
		let db: SQL | null = null;
		try {
			const driver = driverFor(config.dbType);
			db = new SQL(driver.buildOptions(config));
			result.databaseInfo = await driver.ping(db);
			result.ok = true;
			result.message =
				`Connected to ${result.databaseInfo.productName} ` +
				`${result.databaseInfo.productVersion}`;
			// Listing is a convenience on top of a working handshake, so a failure
			// here leaves the databases empty instead of failing the whole test.
			try {
				result.databases = (await driver.listDatabases(db, ""))
					.map((entry) => entry.name)
					.sort();
				if (config.dbType === "postgres") {
					result.schemas = (
						await driver.listSchemas(db, config, config.database)
					).sort();
				}
			} catch {
				result.databases = [];
				result.schemas = [];
			}
			if (config.savePassword && config.password) {
				await saveCredential(config.id, config.username, config.password);
			}
		} catch (error) {
			result.message = normalizeBackendError(error).message;
		} finally {
			if (db) await closeQuietly(db);
		}
		return result;
	},
	/**
	 * Mnemonic bookmarks. These are thin: every decision — which mnemonics
	 * exist, what a file's line looks like now — belongs to `./bookmarkStore`,
	 * which owns the database and the digests.
	 */
	listBookmarks(): Bookmark[] {
		return listStoredBookmarks();
	},
	setBookmark({ mnemonic, path, line, lineText }: Params<"setBookmark">): Bookmark {
		return saveStoredBookmark({ mnemonic, path, line, lineText });
	},
	clearBookmark({ mnemonic }: Params<"clearBookmark">): void {
		clearStoredBookmark(mnemonic);
	},
	resolveBookmark({
		mnemonic,
		text,
	}: Params<"resolveBookmark">): Bookmark | null {
		return resolveStoredBookmark(mnemonic, text);
	},

	async connect({ config }: Params<"connect">) {
		const resolved = await withStoredPassword(config);
		if (resolved.savePassword) {
			if (resolved.password) {
				await saveCredential(
					resolved.id,
					resolved.username,
					resolved.password,
				);
			}
		} else {
			// The user turned saving off; do not leave an older secret behind.
			await forgetStoredCredential(resolved.id, resolved.username);
		}
		const live = await openConnection(resolved, true);
		return {
			connectionId: live.config.id,
			databaseInfo: await driverFor(live.config.dbType).ping(live.db),
		};
	},

	async forgetCredential({
		connectionId,
		username,
	}: Params<"forgetCredential">): Promise<void> {
		await forgetStoredCredential(connectionId, username);
	},

	async disconnect({ connectionId }: Params<"disconnect">): Promise<void> {
		await closeConnection(connectionId);
	},

	async listDatabases({ connectionId }: Params<"listDatabases">) {
		const { db, config } = getServerConnection(connectionId);
		return driverFor(config.dbType).listDatabases(db, "");
	},

	async listSchemas({
		connectionId,
		database,
	}: Params<"listSchemas">) {
		const { db, config } = await getConnection(connectionId, database);
		return driverFor(config.dbType).listSchemas(db, config, database);
	},

	async listTables({ connectionId, database, schema, filter }: Params<"listTables">) {
		const { db, config } = await getConnection(connectionId, database);
		return driverFor(config.dbType).listTables(db, database, schema, filter);
	},

	async listColumns({
		connectionId,
		database,
		schema,
		table,
	}: Params<"listColumns">) {
		const { db, config } = await getConnection(connectionId, database);
		return driverFor(config.dbType).listColumns(db, database, schema, table);
	},

	async listIndexes({
		connectionId,
		database,
		schema,
		table,
	}: Params<"listIndexes">) {
		const { db, config } = await getConnection(connectionId, database);
		return driverFor(config.dbType).listIndexes(db, database, schema, table);
	},

	async listTriggers({
		connectionId,
		database,
		schema,
		table,
	}: Params<"listTriggers">) {
		const { db, config } = await getConnection(connectionId, database);
		return driverFor(config.dbType).listTriggers(db, database, schema, table);
	},

	async listForeignKeys({
		connectionId,
		database,
		schema,
		table,
	}: Params<"listForeignKeys">) {
		const { db, config } = await getConnection(connectionId, database);
		return driverFor(config.dbType).listForeignKeys(db, database, schema, table);
	},

	async tableDdl({ connectionId, database, schema, table }: Params<"tableDdl">) {
		const { db, config } = await getConnection(connectionId, database);
		return driverFor(config.dbType).tableDdl(db, database, schema, table);
	},

	async updateCell({
		connectionId,
		database,
		schema,
		table,
		keyColumns,
		keyValues,
		column,
		value,
	}: Params<"updateCell">) {
		const { db, config } = await getConnection(connectionId, database);
		const isMysql = config.dbType === "mysql";
		const quote = isMysql ? "`" : '"';

		/**
		 * Identifiers cannot be bound as values, so they are quoted instead. The
		 * doubling of the quote character is what keeps a table literally named
		 * `a"b` from breaking out of the identifier.
		 */
		const identifier = (name: string) =>
			quote + name.split(quote).join(quote + quote) + quote;

		// Every primary key column is bound by value, in the order the caller
		// supplied, so a composite key narrows the row the same way the grid shows it.
		const placeholders = keyColumns.map((_, index) =>
			isMysql ? "?" : `$${index + 1}`,
		);
		const valuesStartAt = keyColumns.length;
		const assignmentValue = isMysql ? "?" : `$${valuesStartAt + 1}`;

		const target = isMysql || !schema
			? identifier(table)
			: `${identifier(schema)}.${identifier(table)}`;
		const where = keyColumns
			.map((name, index) => `${identifier(name)} = ${placeholders[index]}`)
			.join(" AND ");

		const sql =
			`UPDATE ${target} SET ${identifier(column)} = ${assignmentValue}` +
			` WHERE ${where}`;

		await db.unsafe(sql, [...keyValues, value]);
		// The grid redraws this row from the re-run SELECT rather than trusting a
		// local guess: a trigger, a generated column or a rejected constraint can
		// all make the stored value differ from what was written.
		return { sql };
	},

	async exportResult({ folder, fileName, contents }: Params<"exportResult">) {
		/**
		 * `fileName` comes from the UI, so it is reduced to a bare file name before
		 * being joined onto the folder. Taking only the last path segment is what
		 * stops `../elsewhere.csv` from writing outside the directory the user
		 * picked; the character filter then removes anything a shell would treat
		 * as syntax. A name left empty or starting with a dot would be an
		 * invisible file in Finder, so those get an explicit prefix instead.
		 */
		const lastSegment = fileName.split(/[\\/]/).pop() ?? "";
		const sanitised = lastSegment.replace(/[^\w. -]/g, "_");
		const safeName =
			sanitised === "" || sanitised.startsWith(".")
				? `export${sanitised}`
				: sanitised;
		const path = join(folder, safeName);
		await Bun.write(path, contents);
		return { path };
	},

	async execute({
		connectionId,
		database,
		sql,
		executionId,
		maxRows,
	}: Params<"execute">) {
		const { db, config } = await getConnection(connectionId, database);
		const statements = splitStatements(sql, config.dbType);
		const startedAt = performance.now();
		const results: StatementResult[] = [];
		cancelledExecutions.delete(executionId);

	const driver = driverFor(config.dbType);
	for (const [index, statement] of statements.entries()) {
			const result = await runStatement(
				db,
				driver,
				statement,
				index,
				maxRows,
				executionId,
			);
			results.push(result);
			emitProgress?.({
				executionId,
				statementIndex: index,
				completed: index + 1,
				total: statements.length,
				executionTimeMs: result.executionTimeMs,
				affectedRows: result.affectedRows,
			});
			// A cancelled batch stops here; the remaining statements are never
			// sent to the server.
			if (cancelledExecutions.has(executionId)) break;
		}
		cancelledExecutions.delete(executionId);

		return {
			statements: results,
			totalExecutionTimeMs: performance.now() - startedAt,
		} satisfies ExecuteResult;
	},

	cancelQuery({ executionId }: Params<"cancelQuery">): boolean {
		cancelledExecutions.add(executionId);
		const query = executions.get(executionId);
		// A stale id (already finished, or never started) cancels nothing but is
		// still honoured for a batch that has not reached this statement yet.
		if (!query) return false;
		executions.delete(executionId);
		try {
			query.cancel();
			return true;
		} catch (error) {
			console.warn(
				"[recall] cancel failed:",
				error instanceof Error ? error.message : error,
			);
			return false;
		}
	},
	/**
	 * Recursive scan of an opened folder. Path safety (a symlink pointing
	 * outside the root is dropped) lives in `./sqlFiles`, which is why the
	 * walker is testable without Electrobun.
	 */
	async listFolder({ folder, filter }: Params<"listFolder">) {
		return listSqlFiles(folder, filter);
	},

	async readSqlFile({ path }: Params<"readSqlFile">) {
		return readSqlFile(path);
	},

	/**
	 * Refuses the write on a version mismatch rather than clobbering an edit
	 * made outside the app. `expectedVersion: null` means "create", so an
	 * existing file comes back as a conflict.
	 */
	async writeSqlFile({ path, content, expectedVersion }: Params<"writeSqlFile">) {
		return writeSqlFile(path, content, expectedVersion);
	},

	/**
	 * Empty file or directory under `parent`. A refused name comes back as
	 * `invalid` and an occupied one as `exists` — data for the field to show,
	 * never an exception that would abort the whole panel.
	 */
	async createSqlEntry({ parent, name, isDir }: Params<"createSqlEntry">) {
		return createSqlEntry(parent, name, isDir);
	},

	/** Renames in place and returns the new path, which the open tab follows. */
	async renameSqlEntry({ path, name }: Params<"renameSqlEntry">) {
		return renameSqlEntry(path, name);
	},

	/**
	 * Recursive delete. A tree refreshed behind the user's back reports
	 * `missing`, which the caller renders as nothing to delete rather than as
	 * a failure they caused.
	 */
	async deleteSqlEntry({ path }: Params<"deleteSqlEntry">) {
		return deleteSqlEntry(path);
	},

	/**
	 * Copy or move of a multi-row selection. Per-entry by design: the ones
	 * that landed are in `moved`, the ones that did not are in `failures`, and
	 * both paths arrive in request order.
	 */
	async transferSqlEntries({
		sources,
		destination,
		move,
	}: Params<"transferSqlEntries">) {
		return transferSqlEntries(sources, destination, move);
	},

} satisfies {
	[K in keyof BunRequests as K extends "pickFolder" | "revealInFolder"
		? never
		: K]: (
		params: BunRequests[K]["params"],
	) => BunRequests[K]["response"] | Promise<BunRequests[K]["response"]>;
};
