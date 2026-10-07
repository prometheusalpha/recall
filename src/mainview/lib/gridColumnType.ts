/**
 * Which colour a result-grid value wears, decided by its column's declared type.
 *
 * The renderer only ever sees the type NAME a driver reported, and the two
 * drivers spell the same idea differently: Postgres answers with the catalog
 * name (`int4`, `timestamptz`, `character varying`, `_int4` for an array) via
 * the `pg_typeof` probe, MySQL answers with nothing at all, so `handlers.ts`
 * falls back to the JS type of the first non-null value (`number`, `string`,
 * `json`, `bytes`). Both spellings land here and collapse onto one small
 * palette, so a cell's colour never depends on which driver produced it.
 *
 * An unrecognised name stays `unknown` and is left on the inherited
 * foreground: a wrong colour on a bit column reads as a claim about the data,
 * and neutral is the one answer that never lies.
 */

/** The semantic buckets that have a colour. */
export const COLUMN_TYPE_KINDS = [
	"integer",
	"numeric",
	"string",
	"boolean",
	"temporal",
	"structured",
	"identifier",
	"binary",
	"spatial",
] as const;

export type ColumnTypeKind = (typeof COLUMN_TYPE_KINDS)[number];

/** A bucket, plus the neutral case a type that did not match anything gets. */
export type ColumnVisualKind = ColumnTypeKind | "unknown";

/**
 * Base type name (lower-cased, parameters and attributes stripped) to bucket.
 *
 * A string rather than a `Map` because every lookup is a plain property read
 * on a frozen literal, and `Object.hasOwn` guards the names that collide with
 * `Object.prototype` (`constructor`, `toString`).
 */
const BASE_KINDS: Record<string, ColumnTypeKind> = {
	// Postgres integer family, by declared name and by `pg_typeof` alias.
	smallint: "integer",
	integer: "integer",
	bigint: "integer",
	serial: "integer",
	smallserial: "integer",
	bigserial: "integer",
	int2: "integer",
	int4: "integer",
	int8: "integer",
	// MySQL integer family.
	tinyint: "integer",
	mediumint: "integer",
	int: "integer",
	year: "integer",

	numeric: "numeric",
	decimal: "numeric",
	dec: "numeric",
	real: "numeric",
	double: "numeric",
	"double precision": "numeric",
	float: "numeric",
	float4: "numeric",
	float8: "numeric",
	money: "numeric",
	smallmoney: "numeric",
	// The value-derived name `columnTypeName` gives a column the probe could
	// not type. A JS number is the closest thing to a numeric column.
	number: "numeric",

	char: "string",
	bpchar: "string",
	character: "string",
	"character varying": "string",
	varchar: "string",
	varchar2: "string",
	nvarchar: "string",
	nchar: "string",
	text: "string",
	tinytext: "string",
	mediumtext: "string",
	longtext: "string",
	clob: "string",
	nclob: "string",
	name: "string",
	citext: "string",
	enum: "string",
	set: "string",
	string: "string",

	bool: "boolean",
	boolean: "boolean",

	date: "temporal",
	time: "temporal",
	timetz: "temporal",
	timestamp: "temporal",
	timestamptz: "temporal",
	"timestamp with time zone": "temporal",
	"timestamp without time zone": "temporal",
	"time with time zone": "temporal",
	"time without time zone": "temporal",
	datetime: "temporal",
	datetime2: "temporal",
	smalldatetime: "temporal",
	interval: "temporal",

	json: "structured",
	jsonb: "structured",
	xml: "structured",
	hstore: "structured",
	array: "structured",

	uuid: "identifier",
	uniqueidentifier: "identifier",
	rowid: "identifier",

	bytea: "binary",
	blob: "binary",
	tinyblob: "binary",
	mediumblob: "binary",
	longblob: "binary",
	binary: "binary",
	varbinary: "binary",
	image: "binary",
	bytes: "binary",
	// A bit string is read as bytes, not as a truth value: MySQL's `bit(1)` is
	// the one exception and it arrives as `number` from the value fallback.
	bit: "binary",
	"bit varying": "binary",

	geometry: "spatial",
	geography: "spatial",
	point: "spatial",
	linestring: "spatial",
	polygon: "spatial",
	multipoint: "spatial",
	multilinestring: "spatial",
	multipolygon: "spatial",
	geometrycollection: "spatial",
};

/**
 * Split a type name into the base name and whether it names an array.
 *
 * Arrays are worth their own pass because Postgres exposes the same array three
 * ways: `int[]` when the value was cast, `_int4` through the catalog, and
 * `array(...)` when a parameter declared it. All three read as one JSON value
 * in the grid, so all three belong to `structured` rather than to the bucket of
 * their element type.
 */
function unwrap(dataType: string): { base: string; array: boolean } {
	let text = dataType.trim().toLowerCase().replace(/\s+/g, " ");
	let array = false;
	for (;;) {
		if (text.endsWith("[]")) {
			array = true;
			text = text.slice(0, -2).trim();
			continue;
		}
		const wrapper = /^array\s*\((.*)\)$/.exec(text);
		if (wrapper !== null) {
			array = true;
			text = (wrapper[1] ?? "").trim();
			continue;
		}
		break;
	}
	// The catalog convention for an array type name (`_int4`, `_text`). The
	// length guard keeps a bare `_` out of it.
	if (!array && text.length > 1 && text.startsWith("_")) {
		array = true;
		text = text.slice(1);
	}
	// Parameters and MySQL column attributes carry no semantics for a colour:
	// `numeric(20,6)` is a numeric, `int unsigned` is an integer.
	const params = text.indexOf("(");
	if (params > 0) text = text.slice(0, params).trim();
	text = text.replace(/\bunsigned\b|\bzerofill\b/g, " ").replace(/\s+/g, " ").trim();
	return { base: text, array };
}

/** The colour bucket a declared type name belongs to, or `unknown`. */
export function resolveColumnVisualKind(dataType: string | undefined): ColumnVisualKind {
	if (!dataType) return "unknown";
	const { base, array } = unwrap(dataType);
	if (base.length === 0) return "unknown";
	if (array) return "structured";
	return Object.hasOwn(BASE_KINDS, base) ? BASE_KINDS[base] : "unknown";
}

const TYPE_CLASSES: Record<ColumnTypeKind, string> = {
	integer: "grid-type-integer",
	numeric: "grid-type-numeric",
	string: "grid-type-string",
	boolean: "grid-type-boolean",
	temporal: "grid-type-temporal",
	structured: "grid-type-structured",
	identifier: "grid-type-identifier",
	binary: "grid-type-binary",
	spatial: "grid-type-spatial",
};

/** The class a cell's text wears, or `undefined` to stay on the foreground. */
export function columnTypeClass(kind: ColumnVisualKind): string | undefined {
	return kind === "unknown" ? undefined : TYPE_CLASSES[kind];
}
