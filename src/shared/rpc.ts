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

import type {
	SqlFileContent,
	SqlFileNode,
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