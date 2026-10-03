import type { RPCSchema } from "electrobun/view";
import type {
	ColumnInfo,
	ConnectionConfig,
	ConnectionProfile,
	ConnectionTestResult,
	DatabaseConnectionInfo,
	DatabaseInfo,
	ExecuteResult,
	ForeignKeyInfo,
	IndexInfo,
	TableInfo,
	TriggerInfo,
} from "./types";

import type { Bookmark } from "./bookmark";

import type {
	SqlFileContent,
	SqlFileNode,
	SqlFileOpBatchResult,
	SqlFileOpResult,
	SqlFileWriteResult,
} from "./sqlFile";
/**
 * Requests the renderer sends to the Bun process (executed in Bun).
 * One method per driver operation, mirroring the reference app's Tauri command
 * surface but stripped to the postgres + mysql minimum.
 */
export type BunRequests = {
	/**
	 * Every stored profile, in sidebar order. `password` always comes back
	 * empty — the keychain is the only place a secret is kept, and `connect`
	 * asks the backend to fill one in.
	 */
	listConnections: {
		params: Record<string, never>;
		response: ConnectionConfig[];
	};
	/**
	 * Replace the stored profile list with `configs`. Written whole, in one
	 * transaction, so the database never holds half a list.
	 */
	saveConnections: {
		params: { configs: ConnectionProfile[] };
		response: void;
	};
	testConnection: {
		params: { config: ConnectionConfig };
		response: ConnectionTestResult;
	};
	connect: {
		params: { config: ConnectionConfig };
		response: { connectionId: string; databaseInfo: DatabaseConnectionInfo };
	};
	disconnect: {
		params: { connectionId: string };
		response: void;
	};
	listDatabases: {
		params: { connectionId: string };
		response: DatabaseInfo[];
	};
	/**
	 * Schemas inside one database. Postgres only; MySQL answers with [] because
	 * it has no schema level below a database. A Postgres session is pinned to
	 * its database, so this opens (and keeps) a session for `database`.
	 */
	listSchemas: {
		params: { connectionId: string; database: string };
		response: string[];
	};
	/**
	 * Drop the stored secret for a profile the user no longer wants kept.
	 * Passwords live in the OS credential store, keyed by connection id.
	 */
	forgetCredential: {
		params: { connectionId: string; username: string };
		response: void;
	};
	listTables: {
		params: {
			connectionId: string;
			database: string;
			schema: string;
			filter: string;
		};
		response: TableInfo[];
	};
	listColumns: {
		params: {
			connectionId: string;
			database: string;
			schema: string;
			table: string;
		};
		response: ColumnInfo[];
	};
	/** Indexes, primary keys and unique constraints on one table. */
	listIndexes: {
		params: {
			connectionId: string;
			database: string;
			schema: string;
			table: string;
		};
		response: IndexInfo[];
	};
	/** Triggers defined on one table, with timing, event and body. */
	listTriggers: {
		params: {
			connectionId: string;
			database: string;
			schema: string;
			table: string;
		};
		response: TriggerInfo[];
	};
	/** Foreign-key constraints declared on one table. */
	listForeignKeys: {
		params: {
			connectionId: string;
			database: string;
			schema: string;
			table: string;
		};
		response: ForeignKeyInfo[];
	};
	tableDdl: {
		params: {
			connectionId: string;
			database: string;
			schema: string;
			table: string;
		};
		response: string;
	};
	/**
	 * Rewrite one cell of a table row, addressed by its primary key. The caller
	 * sends the key columns it already rendered, so the backend never has to
	 * re-discover the table's keys.
	 */
	updateCell: {
		params: {
			connectionId: string;
			database: string;
			schema: string;
			table: string;
			/** Primary key columns, in the order their values are supplied. */
			keyColumns: string[];
			keyValues: unknown[];
			column: string;
			value: unknown;
		};
		response: { sql: string };
	};
	/** Write a serialised result set to a file the user picked a folder for. */
	exportResult: {
		params: { folder: string; fileName: string; contents: string };
		response: { path: string };
	};
	execute: {
		params: {
			connectionId: string;
			database: string;
			schema: string;
			sql: string;
			executionId: string;
			maxRows: number;
		};
		response: ExecuteResult;
	};
	cancelQuery: {
		params: { executionId: string };
		response: boolean;
	};
	/** Native directory picker. Resolves null when the user cancels. */
	pickFolder: {
		params: Record<string, never>;
		response: string | null;
	};
	/** Recursive scan of an opened folder, filtered by a filename glob. */
	listFolder: {
		params: { folder: string; filter: string };
		response: SqlFileNode[];
	};
	readSqlFile: {
		params: { path: string };
		response: SqlFileContent;
	};
	/**
	 * Write a file back. `expectedVersion` is the token from the last read; a
	 * mismatch means the file changed on disk and the write is refused rather
	 * than clobbering the user's other edits.
	 */
	writeSqlFile: {
		params: { path: string; content: string; expectedVersion: string | null };
		response: SqlFileWriteResult;
	};

	/**
	 * Create an empty file or a directory under `parent`. Fails with
	 * `exists` rather than overwriting, and the new name is validated by the
	 * backend, so a separator or a `..` in it cannot escape the folder.
	 */
	createSqlEntry: {
		params: { parent: string; name: string; isDir: boolean };
		response: SqlFileOpResult;
	};
	/** Rename one entry in place. The tab open on it follows the new path. */
	renameSqlEntry: {
		params: { path: string; name: string };
		response: SqlFileOpResult;
	};
	/**
	 * Delete one entry, recursively for a directory. Missing is reported as
	 * data so a tree refreshed behind the user's back does not look like an
	 * error the user caused.
	 */
	deleteSqlEntry: {
		params: { path: string };
		response: SqlFileOpResult;
	};
	/**
	 * Copy (`move: false`) or move (`move: true`) entries into `destination`.
	 * A batch, because cut/copy can select several rows at once, and
	 * per-entry, because one refused name must not lose the rest. Each `moved`
	 * entry pairs its new path with the source it came from, so the caller can
	 * repair state keyed on the old path even when only part of the batch landed.
	 */
	transferSqlEntries: {
		params: {
			sources: string[];
			destination: string;
			move: boolean;
		};
		response: SqlFileOpBatchResult;
	};
	/**
	 * Every mnemonic bookmark, ordered by mnemonic. Rows whose file has been
	 * deleted are dropped by the backend rather than reported, so the list only
	 * ever holds bookmarks that can still be jumped to.
	 */
	listBookmarks: {
		params: Record<string, never>;
		response: Bookmark[];
	};
	/**
	 * Bind a mnemonic to a line of a file. `lineText` is the line itself: the
	 * renderer holds the editor's text and the backend owns the digest, so the
	 * the bookmark survives edits that shift it. A mnemonic already in use is
	 * replaced.
	 */
	setBookmark: {
		params: { mnemonic: string; path: string; line: number; lineText: string };
		response: Bookmark;
	};
	/** Drop one bookmark. */
	clearBookmark: {
		params: { mnemonic: string };
		response: void;
	};
	/**
	 * Re-anchor a bookmark against the current text of its file and report
	 * where it now points. Null when the mnemonic is unset or its file is gone.
	 */
	resolveBookmark: {
		params: { mnemonic: string; text: string };
		response: Bookmark | null;
	};
	/** Show a file in Finder / Explorer. */
	revealInFolder: {
		params: { path: string };
		response: void;
	};
};

/**
 * Requests the Bun process sends to the renderer (executed in the webview).
 * None today; the key exists so the schema is symmetric and extensible.
 */
export type WebviewRequests = {
	noop: { params: Record<string, never>; response: void };
};

/**
 * One-way payloads.
 *
 * `bun.messages` flows renderer -> Bun; `webview.messages` flows Bun -> renderer.
 * Every push the main process makes today (query progress, connection loss) is
 * Bun -> renderer, so `bun.messages` is intentionally empty.
 */
export type AppRPC = {
	bun: RPCSchema<{
		requests: BunRequests;
		messages: Record<never, never>;
	}>;
	webview: RPCSchema<{
		requests: WebviewRequests;
		messages: {
			queryProgress: {
				executionId: string;
				statementIndex: number;
				completed: number;
				total: number;
				executionTimeMs: number;
				affectedRows: number;
			};
			connectionLost: { connectionId: string; reason: string };
		};
	}>;
};