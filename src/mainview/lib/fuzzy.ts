/**
 * Ranked fuzzy matching for the quick-open palette.
 *
 * The scoring rule, in one line: **lower score wins**, and a score is
 * `tier base + length penalty`, where the tier bases are 100 apart and the
 * length penalty is capped at 99. That gap is the whole design: because a
 * penalty can never reach the next tier's base, a better tier always outranks
 * a worse one no matter how short or long the text is, and inside one tier the
 * shorter `text` wins — which is what makes `users` beat `users_archive_2019`
 * for the query `users`.
 */

/** Match quality, best first. Every tier below the previous one. */
export type FuzzyMatchKind =
	| "exact"
	| "prefix"
	| "word-prefix"
	| "substring"
	| "fuzzy";

export interface FuzzyMatch {
	kind: FuzzyMatchKind;
	/** Lower is better. See the note at the top of this file. */
	score: number;
	/** Matched character positions in `text`, ascending, for highlighting. */
	indices: number[];
}

const TIER_BASE: Record<FuzzyMatchKind, number> = {
	exact: 0,
	prefix: 100,
	"word-prefix": 200,
	substring: 300,
	fuzzy: 400,
};

/** Kept one below the tier gap so a penalty can never promote a tier. */
const MAX_LENGTH_PENALTY = 99;

/** Characters that end a word in a snake/kebab/dotted identifier. */
const SEPARATORS = " _-./\\";

/**
 * Whether a match starting at `index` begins a word: the text starts there, or
 * the previous character is a separator, or it is a camelCase hump (lower or
 * digit followed by upper).
 */
function isWordStart(text: string, index: number): boolean {
	if (index === 0) return true;
	const previous = text[index - 1];
	if (SEPARATORS.includes(previous)) return true;
	const current = text[index];
	const previousIsLower =
		(previous >= "a" && previous <= "z") || (previous >= "0" && previous <= "9");
	return previousIsLower && current >= "A" && current <= "Z";
}

function range(from: number, length: number): number[] {
	const indices: number[] = [];
	for (let offset = 0; offset < length; offset += 1) indices.push(from + offset);
	return indices;
}

/**
 * Leftmost greedy subsequence scan, i.e. `ue` matches `users` at 0 and 2.
 * Returns null when `text` does not contain `query` in order.
 */
function subsequence(lowerQuery: string, lowerText: string): number[] | null {
	const indices: number[] = [];
	let cursor = 0;
	for (let index = 0; index < lowerText.length; index += 1) {
		if (lowerText[index] !== lowerQuery[cursor]) continue;
		indices.push(index);
		cursor += 1;
		if (cursor === lowerQuery.length) return indices;
	}
	return null;
}

/**
 * Scores `query` against `text`, case-insensitively, and returns the matched
 * character positions for highlighting — or null when nothing matches.
 *
 * An empty query matches nothing: the palette shows an empty state rather than
 * an unranked dump of every table on the server.
 */
export function matchFuzzy(query: string, text: string): FuzzyMatch | null {
	if (!query || !text) return null;
	const lowerQuery = query.toLowerCase();
	const lowerText = text.toLowerCase();

	// Same penalty in every tier: how much longer the target is than the query.
	const penalty = Math.min(
		Math.max(lowerText.length - lowerQuery.length, 0),
		MAX_LENGTH_PENALTY,
	);
	const score = (kind: FuzzyMatchKind): number => TIER_BASE[kind] + penalty;

	if (lowerText === lowerQuery) {
		return {
			kind: "exact",
			score: score("exact"),
			indices: range(0, text.length),
		};
	}

	if (lowerText.startsWith(lowerQuery)) {
		return {
			kind: "prefix",
			score: score("prefix"),
			indices: range(0, lowerQuery.length),
		};
	}

	// Earliest occurrence that starts on a word boundary, e.g. `login` in
	// `user_login_table` — better than the same word buried mid-identifier.
	let wordStart = -1;
	for (
		let index = lowerText.indexOf(lowerQuery);
		index >= 0;
		index = lowerText.indexOf(lowerQuery, index + 1)
	) {
		if (isWordStart(text, index)) {
			wordStart = index;
			break;
		}
	}
	if (wordStart >= 0) {
		return {
			kind: "word-prefix",
			score: score("word-prefix"),
			indices: range(wordStart, lowerQuery.length),
		};
	}

	const substringAt = lowerText.indexOf(lowerQuery);
	if (substringAt >= 0) {
		return {
			kind: "substring",
			score: score("substring"),
			indices: range(substringAt, lowerQuery.length),
		};
	}

	const indices = subsequence(lowerQuery, lowerText);
	if (!indices) return null;
	return { kind: "fuzzy", score: score("fuzzy"), indices };
}
