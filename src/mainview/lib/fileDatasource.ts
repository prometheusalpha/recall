/**
 * Which datasource a `.sql` file opens against.
 *
 * A file runs against its own binding when it has one, and otherwise against
 * the connection the user is currently on. Both the Files panel and the quick
 * open palette need that answer, and a bookmark needs it to open the file a
 * jump points at, so the rule lives here rather than in three callers.
 */
import type { FileDatasource } from "../../shared/sqlFile";
import type { ConnectionConfig } from "../../shared/types";

export interface DatasourceResolution {
	datasource: FileDatasource;
	/** True when the file has no usable binding and the active connection was used. */
	usedFallback: boolean;
}

/**
 * Returns null when there is no connection at all, which is the one case where
 * a file cannot be opened. A binding whose connection has since been deleted
 * falls through to the fallback rather than dead-ending on a missing profile.
 */
export function resolveFileDatasource(
	path: string,
	bindings: Record<string, FileDatasource>,
	configs: ConnectionConfig[],
	activeId: string | null,
): DatasourceResolution | null {
	const bound = bindings[path];
	if (bound && configs.some((config) => config.id === bound.connectionId)) {
		return { datasource: bound, usedFallback: false };
	}

	const fallback =
		configs.find((config) => config.id === activeId) ?? configs[0];
	if (!fallback) return null;
	return {
		datasource: {
			connectionId: fallback.id,
			database: fallback.database,
			schema: fallback.dbType === "mysql" ? "" : fallback.defaultSchema,
		},
		usedFallback: true,
	};
}