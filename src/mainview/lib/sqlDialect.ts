/**
 * CodeMirror SQL dialects, one per `DatabaseType`.
 *
 * Both dialects are built with `SQLDialect.define` rather than reusing the
 * library's stock `PostgreSQL`/`MySQL` exports so every field we depend on is
 * stated explicitly and visible next to the others.
 *
 * The words themselves live in `sqlLexicon`, which the clause band reads too:
 * everything here is what CodeMirror needs from them, and nothing else in the
 * app should have to load CodeMirror to know what a keyword is.
 */
import { SQLDialect } from "@codemirror/lang-sql";
import type { DatabaseType } from "../../shared/types";
import {
	IDENTIFIER_QUOTES,
	MYSQL_KEYWORDS,
	MYSQL_TYPES,
	POSTGRES_KEYWORDS,
	POSTGRES_TYPES,
} from "./sqlLexicon";

/**
 * Postgres: folded (case-insensitive) unquoted identifiers, `"` for quoted
 * identifiers, no backslash escapes, `$$…$$` dollar-quoted bodies.
 */
const postgresDialect = SQLDialect.define({
	keywords: POSTGRES_KEYWORDS,
	types: POSTGRES_TYPES,
	identifierQuotes: IDENTIFIER_QUOTES.postgres,
	backslashEscapes: false,
	doubleQuotedStrings: false,
	caseInsensitiveIdentifiers: true,
	doubleDollarQuotedStrings: true,
	spaceAfterDashes: false,
});

/**
 * MySQL: backticks are the identifier quote (`"` is a string), backslash
 * escapes are live, `#` starts a comment, and `--` only comments after a space.
 */
const mysqlDialect = SQLDialect.define({
	keywords: MYSQL_KEYWORDS,
	types: MYSQL_TYPES,
	identifierQuotes: IDENTIFIER_QUOTES.mysql,
	backslashEscapes: true,
	doubleQuotedStrings: true,
	caseInsensitiveIdentifiers: false,
	doubleDollarQuotedStrings: false,
	spaceAfterDashes: true,
	hashComments: true,
});

const DIALECTS: Record<DatabaseType, SQLDialect> = {
	postgres: postgresDialect,
	mysql: mysqlDialect,
};

const NAMES: Record<DatabaseType, string> = {
	postgres: "PostgreSQL",
	mysql: "MySQL",
};

/** The configured CodeMirror dialect for a connection type. */
export function codeMirrorSqlDialect(dbType: DatabaseType): SQLDialect {
	return DIALECTS[dbType];
}

/** Human-readable product name, for labels and window titles. */
export function dialectName(dbType: DatabaseType): string {
	return NAMES[dbType];
}
