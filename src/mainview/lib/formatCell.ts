/**
 * Cell text for the result grid.
 *
 * Extracted from ResultGrid so the auto-width sampler and the grid paint the
 * identical string: a column measured with one formatting and painted with
 * another clips its content or leaves a gap.
 */

/**
 * Timezone used to render columns that carry an absolute instant. The value
 * arrives as UTC because `toJsonSafe` normalises it, which reads as the wrong
 * wall clock for a row written in Vietnam.
 */
export const DISPLAY_TIME_ZONE = "Asia/Bangkok";

/** Appended to a rendered instant so the zone is never ambiguous. */
const DISPLAY_OFFSET = "+07";

/**
 * Type names Postgres (`pg_typeof`) and MySQL report for a value stored as UTC
 * and converted per session. Postgres spells a wall clock `timestamp without
 * time zone`, so the bare `timestamp` here is MySQL's — no collision.
 *
 * Everything else that looks like a date is a wall clock the database never
 * meant to shift: `timestamp without time zone`, `date`, `time`.
 */
const ABSOLUTE_INSTANT_TYPES: Record<string, true> = {
	"timestamp with time zone": true,
	timestamptz: true,
	// MySQL's instant type. Postgres never reports a bare `timestamp`.
	timestamp: true,
};

const instantFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: DISPLAY_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	// h23, not hour12:false, which renders midnight as 24 in some ICU builds.
	hourCycle: "h23",
});

/** ISO instant to `YYYY-MM-DD HH:MM:SS+07`, or null when unparseable. */
function formatInstant(isoValue: string): string | null {
	const ms = Date.parse(isoValue);
	if (!Number.isFinite(ms)) return null;
	const field: Record<string, string> = {};
	for (const part of instantFormatter.formatToParts(new Date(ms))) {
		field[part.type] = part.value;
	}
	return (
		`${field.year}-${field.month}-${field.day} ` +
		`${field.hour}:${field.minute}:${field.second}${DISPLAY_OFFSET}`
	);
}

/**
 * A JSON-safe driver value as the text a cell shows. `columnType` is the type
 * name the database reported, which is the only thing that separates an
 * instant from a wall clock once both are ISO strings.
 */
export function formatCellValue(value: unknown, columnType?: string): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") {
		if (columnType !== undefined) {
			const type = columnType.toLowerCase();
			if (ABSOLUTE_INSTANT_TYPES[type] === true) {
				const rendered = formatInstant(value);
				if (rendered !== null) return rendered;
			}
		}
		return value;
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint"
	) {
		return value.toString();
	}
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}