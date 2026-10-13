/**
 * Cell text for the result grid.
 *
 * Extracted from ResultGrid so the auto-width sampler and the grid paint the
 * identical string: a column measured with one formatting and painted with
 * another clips its content or leaves a gap.
 */

/**
 * Timezone used to render columns that carry an absolute instant: the value
 * arrives as UTC (`Date`) or with the session offset as Postgres text, and
 * reading either in the session zone shows the wrong wall clock for a row
 * written in Vietnam. Named rather than fixed so the formatter shifts the wall
 * clock; the `+07` suffix is a constant that keeps the rendered string stable.
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

/**
 * ISO-8601 instant with a mandatory offset: `Z` or `±HH[:MM[:SS]]`. Both the
 * Postgres text the driver reads (`2026-01-01T06:15:00.123456-05:45`, offset
 * always has minutes) and the millisecond ISO `Z` `Date` fallback share this
 * shape, so one parse serves both. Anything else — `infinity`, Postgres
 * `date`/`time` text, any future non-ISO shape — misses and is left untouched.
 */
const ISO_INSTANT =
	/^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2}(?::\d{2})?)$/;

/** Offset text from an ISO instant as milliseconds to subtract to reach UTC. */
function offsetMs(offsetText: string): number {
	if (offsetText === "Z") return 0;
	const sign = offsetText.startsWith("-") ? -1 : 1;
	const digits = offsetText.slice(1).replace(/:/g, "");
	const hours = Number(digits.slice(0, 2));
	const minutes = Number(digits.slice(2, 4));
	const seconds = Number(digits.slice(4, 6)) || 0;
	return sign * (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/** ISO instant to `YYYY-MM-DD HH:MM:SS[.fff…]+07`, or null when unparseable. */
function formatInstant(isoValue: string): string | null {
	const match = ISO_INSTANT.exec(isoValue);
	if (match === null) return null;
	const [, year, month, day, hour, minute, second, fraction, offsetText] = match;
	// setUTCFullYear, not the Date(y, …) constructor, so a year below 100 is not
	// remapped into the 20th century.
	const wall = new Date(0);
	wall.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
	wall.setUTCHours(Number(hour), Number(minute), Number(second), 0);
	const utcMs = wall.getTime() - offsetMs(offsetText);
	if (!Number.isFinite(utcMs)) return null;
	const field: Record<string, string> = {};
	for (const part of instantFormatter.formatToParts(new Date(utcMs))) {
		field[part.type] = part.value;
	}
	// The fraction never enters the Date, so it is spliced back verbatim: a
	// minute-resolution re-zone cannot touch fractional digits, and microseconds
	// survive. No fraction in means no fraction out.
	return (
		`${field.year}-${field.month}-${field.day} ` +
		`${field.hour}:${field.minute}:${field.second}${fraction ?? ""}${DISPLAY_OFFSET}`
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