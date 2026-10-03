import type { ConnectionConfig, DatabaseType } from "@shared/types";

/** Default TCP port per driver. */
export const DEFAULT_PORTS: Record<DatabaseType, number> = {
	postgres: 5432,
	mysql: 3306,
};

/** Default account name per driver. */
export const DEFAULT_USERS: Record<DatabaseType, string> = {
	postgres: "postgres",
	mysql: "root",
};

/** Human labels for the two drivers the app supports. */
export const DB_TYPE_LABELS: Record<DatabaseType, string> = {
	postgres: "PostgreSQL",
	mysql: "MySQL",
};

export const MYSQL_URL_PARAMS_PLACEHOLDER = "charset=utf8mb4";
export const POSTGRES_URL_PARAMS_PLACEHOLDER =
	"sslmode=verify-full&application_name=recall";

/** Seconds to wait for the driver handshake before giving up. */
const DEFAULT_CONNECT_TIMEOUT_SECS = 10;

/** Postgres TLS modes, spelled the way `libpq` expects them. */
export const POSTGRES_TLS_MODES = [
	"disable",
	"prefer",
	"require",
	"verify-ca",
	"verify-full",
] as const;
export type PostgresTlsMode = (typeof POSTGRES_TLS_MODES)[number];

/** MySQL TLS modes, as spelled by `mysql2`/the MySQL client. */
export const MYSQL_TLS_MODES = [
	"disabled",
	"preferred",
	"required",
	"verify_ca",
	"verify_identity",
] as const;
export type MysqlTlsMode = (typeof MYSQL_TLS_MODES)[number];

export const POSTGRES_TLS_MODE_LABELS: Record<PostgresTlsMode, string> = {
	disable: "Disable",
	prefer: "Prefer",
	require: "Require",
	"verify-ca": "Verify CA",
	"verify-full": "Verify Full",
};

export const MYSQL_TLS_MODE_LABELS: Record<MysqlTlsMode, string> = {
	disabled: "Disabled",
	preferred: "Preferred",
	required: "Required",
	verify_ca: "Verify CA",
	verify_identity: "Verify Identity",
};

/**
 * Every `urlParams` key that stands for "the TLS mode" on each driver. They are
 * aliases of one setting, so writing one clears the others.
 */
const TLS_MODE_KEYS: Record<DatabaseType, readonly string[]> = {
	postgres: ["sslmode"],
	mysql: ["ssl-mode", "sslmode", "ssl"],
};

/**
 * The `urlParams` value each TLS mode writes, or `null` when the mode is the
 * bare on/off flag carried by `ConnectionConfig.ssl` and needs no parameter.
 * These are the spellings the Bun drivers in `src/bun/drivers` understand.
 */
const TLS_MODE_PARAMS: Record<DatabaseType, Record<string, string | null>> = {
	postgres: {
		disable: "disable",
		prefer: "prefer",
		require: "require",
		"verify-ca": "verify-ca",
		"verify-full": "verify-full",
	},
	mysql: {
		disabled: null,
		preferred: null,
		required: "require",
		verify_ca: "verify-ca",
		verify_identity: "verify-full",
	},
};

/** URL parameter names carrying each TLS material file path. */
export const TLS_FILE_KEYS: Record<
	DatabaseType,
	{ ca: string; cert: string; key: string }
> = {
	postgres: { ca: "sslrootcert", cert: "sslcert", key: "sslkey" },
	mysql: { ca: "ssl-ca", cert: "ssl-cert", key: "ssl-key" },
};

/** The TLS mode a config currently requests, derived from its own fields. */
export function tlsModeOf(
	config: ConnectionConfig,
): PostgresTlsMode | MysqlTlsMode {
	for (const key of TLS_MODE_KEYS[config.dbType]) {
		const raw = readUrlParam(config.urlParams, key);
		if (raw === "") continue;
		if (config.dbType === "postgres") {
			const modes: readonly string[] = POSTGRES_TLS_MODES;
			if (modes.includes(raw)) return raw as PostgresTlsMode;
			break;
		}
		if (raw === "verify-ca") return "verify_ca";
		if (raw === "verify-full") return "verify_identity";
		if (raw === "require") return "required";
		break;
	}
	return config.dbType === "postgres"
		? config.ssl
			? "prefer"
			: "disable"
		: config.ssl
			? "preferred"
			: "disabled";
}

/**
 * Returns a copy of `config` with the TLS mode applied: the driver's URL
 * parameter is rewritten and `ssl` is kept in step so the flag and the
 * parameter never disagree.
 */
export function withTlsMode(
	config: ConnectionConfig,
	mode: PostgresTlsMode | MysqlTlsMode,
): ConnectionConfig {
	const value = (TLS_MODE_PARAMS[config.dbType] as Record<string, string | null>)[
		mode
	];
	return {
		...config,
		urlParams: setUrlParam(config.urlParams, TLS_MODE_KEYS[config.dbType], value),
		ssl: mode !== "disable" && mode !== "disabled",
	};
}

/**
 * Reads one parameter out of a raw query string. Mirrors the Bun side's
 * `parseUrlParams` (leading `?`/`&` tolerated, `+` is a space) so the form and
 * the driver always agree on what a config means.
 */
export function readUrlParam(urlParams: string, key: string): string {
	for (const part of urlParams.trim().replace(/^[?&]+/, "").split("&")) {
		if (!part) continue;
		const eq = part.indexOf("=");
		const name = (eq === -1 ? part : part.slice(0, eq)).trim();
		if (name !== key) continue;
		const raw = eq === -1 ? "" : part.slice(eq + 1).trim();
		try {
			return decodeURIComponent(raw.replace(/\+/g, " "));
		} catch {
			return raw;
		}
	}
	return "";
}

/**
 * Rewrites one URL parameter. Every name in `keys` is treated as the same
 * setting, so all of them are dropped before `value` is written. A `null` or
 * empty value removes the parameter entirely.
 */
export function setUrlParam(
	urlParams: string,
	keys: readonly string[],
	value: string | null,
): string {
	const kept: string[] = [];
	for (const part of urlParams.trim().replace(/^[?&]+/, "").split("&")) {
		if (!part) continue;
		const eq = part.indexOf("=");
		const name = (eq === -1 ? part : part.slice(0, eq)).trim();
		if (keys.includes(name)) continue;
		kept.push(part.trim());
	}
	if (value !== null && value !== "") kept.push(`${keys[0]}=${value}`);
	return kept.join("&");
}

/** Fields of a connection config that can fail validation. */
export type ConnectionFieldKey =
	| "name"
	| "host"
	| "port"
	| "username"
	| "database"
	| "defaultSchema"
	| "urlParams";

export type ConnectionFieldErrors = Partial<Record<ConnectionFieldKey, string>>;

/** A fresh, unsaved profile for `dbType`. */
export function emptyConnection(dbType: DatabaseType): ConnectionConfig {
	return {
		id: crypto.randomUUID(),
		name: "",
		dbType,
		host: "localhost",
		port: DEFAULT_PORTS[dbType],
		username: DEFAULT_USERS[dbType],
		password: "",
		database: "",
		defaultSchema: dbType === "postgres" ? "public" : "",
		ssl: false,
		urlParams: "",
		connectTimeoutSecs: DEFAULT_CONNECT_TIMEOUT_SECS,
		queryTimeoutSecs: 0,
		note: "",
		savePassword: true,
		showSystemSchemas: false,
	};
}
