/**
 * CodeMirror SQL dialects, one per `DatabaseType`.
 *
 * Both dialects are built with `SQLDialect.define` rather than reusing the
 * library's stock `PostgreSQL`/`MySQL` exports so every field we depend on is
 * stated explicitly and visible next to the others.
 */
import { SQLDialect } from "@codemirror/lang-sql";
import type { DatabaseType } from "../../shared/types";

const POSTGRES_KEYWORDS =
	"abort absolute access action add admin after aggregate all also alter always analyse analyze and any array as asc assertion assignment at attach attribute authorization backward before begin between both by cache call cascade cascaded case cast catalog chain characteristics check checkpoint class close cluster coalesce collate collation collation_catalog column columns comment comments commit committed concurrently configuration conflict connection constraints content continue conversion copy cost create cross csv cube current current_catalog current_date current_role current_schema current_time current_timestamp current_user cursor cycle data database day deallocate declare default defaults deferrable deferred definer delete delimiter delimiters depends desc detach dictionary disable discard distinct do document domain double drop each else enable encoding encrypted end enum escape event except exclude excluding exclusive execute exists explain expression extension external extract false family fetch filter first following for force foreign forward freeze from full function functions generated global grant granted greatest group grouping groups handler having header hold hour identity if ignore ilike immediate immutable implicit import in include including increment index indexes inherit inherits initially inline inner inout input insensitive insert instead invoker isolation key label language large last lateral leakproof least left level like limit listen load local localtime localtimestamp location lock locked logged mapping match materialized maxvalue method minute minvalue mode month move name names national natural nchar new next no none not nothing notify notnull nowait null nullif nulls object of off oids old on only operator option options or order ordinality out outer over overlaps owned owner parser partial partition passing password plans policy preceding precision prepare prepared preserve primary prior privileges procedural procedure program quote range read real reassign recheck recursive ref references referencing refresh reindex relative release rename repeatable replace replica reset restart restrict return returns revoke role rollback rollup routine row rows rule savepoint scale schema scroll search second security select sequence sequences serializable server session set setof sets share show simple skip snapshot sql stable standalone start statement statistics stdin stdout storage strict strip structure subscription support sysid system table tables tablesample tablespace temp template temporary text then ties to transaction transform treat trigger trim true truncate trusted type types unbounded uncommitted unencrypted unknown unlisten unlogged until update user using vacuum valid validate validator value values varying verbose version view views volatile when where whitespace window with within without work wrapper write xml year yes zone";

const POSTGRES_TYPES =
	"bigint bigserial bit boolean box bytea char character cidr circle date decimal float4 float8 inet int int2 int4 int8 integer interval json jsonb line lseg macaddr macaddr8 money numeric path pg_lsn point polygon real smallint serial serial2 serial4 serial8 smallserial text time timestamp timestamptz tsquery tsvector uuid varbit varchar xml";

const MYSQL_KEYWORDS =
	"accessible add all alter analyze and as asc asensitive before between bigint binary blob both by call cascade case change char character check collate collation column condition constraint continue convert create cross current_date current_time current_timestamp current_user cursor database databases day_hour day_microsecond day_minute day_second dec decimal declare default delayed delete desc describe deterministic distinct distinctrow div double drop dual each else elseif enclosed escaped exists exit explain false fetch float float4 float8 for force foreign from fulltext grant group having high_priority hour_microsecond hour_minute hour_second if ignore in index infile inner inout insensitive insert int int1 int2 int3 int4 int8 integer interval into io_after_gtids io_before_gtids is iterate join key keys kill leading leave left like limit linear lines load localtime localtimestamp lock long longblob longtext loop low_priority master_bind match maxvalue mediumblob mediumint mediumtext middleint minute_microsecond minute_second mod modifies natural not no_write_to_binlog null numeric on optimize optimizer_costs option optionally or order out outer outfile precision primary procedure purge range read reads read_write real references regexp release rename repeat replace require restrict return revoke right rlike schema schemas second_microsecond select sensitive separator set show smallint spatial specific sql sqlexception sqlstate sqlwarning sql_big_result sql_calc_found_rows sql_small_result ssl starting stored straight_join table tables terminated then tinyblob tinyint tinytext to trailing trigger true undo union unique unlock unsigned update usage use using utc_date utc_time utc_timestamp values varbinary varchar varcharacter varying when where while with write xor year_month zerofill";

const MYSQL_TYPES =
	"bigint binary bit blob boolean char date datetime decimal double enum float float4 float8 geometry geometrycollection int int1 int2 int3 int4 int8 integer json linestring longblob longtext mediumblob mediumint mediumtext multilinestring multipoint multipolygon point polygon set text time timestamp tinyblob tinyint tinyint unsigned varbinary varchar year";

/**
 * Postgres: folded (case-insensitive) unquoted identifiers, `"` for quoted
 * identifiers, no backslash escapes, `$$…$$` dollar-quoted bodies.
 */
const postgresDialect = SQLDialect.define({
	keywords: POSTGRES_KEYWORDS,
	types: POSTGRES_TYPES,
	identifierQuotes: "\"",
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
	identifierQuotes: "`",
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
