/**
 * Mnemonic snippet completions for the SQL editor.
 *
 * The provider matches on the snippet's *prefix*, never on arbitrary text, and
 * never rewrites the document: the user sees a popup, chooses an entry, and only
 * then is the body inserted. Auto-expanding on a keystroke would rewrite SQL
 * while it is being typed.
 *
 * Everything here is CodeMirror-free at runtime — the caller passes in
 * `snippetCompletion` from the lazily loaded `@codemirror/autocomplete`
 * namespace, so this module can be imported from the entry bundle without
 * dragging the editor in.
 */
import { snippetPrefixKey, type SqlSnippet } from "../../lib/sqlSnippets";
import type {
	Completion,
	CompletionContext,
	CompletionResult,
	CompletionSource,
} from "@codemirror/autocomplete";

export interface SnippetCompletionItem {
	/** The prefix — this is what CodeMirror filters the popup against. */
	label: string;
	/** The human label shown next to the prefix. */
	detail: string;
	/** Ranking hint; higher sorts first. */
	boost: number;
	type: "snippet";
	/** True when the typed query is exactly this prefix. */
	exactMatch: boolean;
	/** The raw body template, expanded by `snippetCompletion` on accept. */
	apply: string;
}

/**
 * CodeMirror adds `boost` on top of its fuzzy match score, and keyword
 * completions arrive with no boost at all. A mnemonic the user deliberately
 * typed should therefore win even when the popup also lists fuzzy SQL keywords,
 * so an exact prefix match gets a constant far above any achievable match score.
 * 40k mirrors the value the reference client uses; anything in the low tens of
 * thousands behaves the same way.
 */
const EXACT_PREFIX_BOOST = 40_000;

/** Baseline for "this snippet's prefix starts with what I typed". */
const PREFIX_MATCH_BOOST = 4_000;

/**
 * A snippet prefix is a bare mnemonic, so only an identifier-shaped run of
 * characters can be one. This also stops the popup from firing mid-string or
 * mid-comment-free punctuation.
 */
const WORD_BEFORE_CURSOR = /[\p{L}\p{N}_$]+/u;

/**
 * Builds the popup entries for the word the user has typed so far.
 *
 * Returns nothing for an empty query: an empty word is not a mnemonic, and
 * offering the whole snippet list on every empty line would bury keywords.
 */
export function buildSnippetCompletions(
	snippets: readonly SqlSnippet[],
	query: string,
): SnippetCompletionItem[] {
	const key = snippetPrefixKey(query);
	if (!key) return [];
	return snippets
		.filter(
			(snippet) =>
				snippet.enabled && snippetPrefixKey(snippet.prefix).startsWith(key),
		)
		.map((snippet): SnippetCompletionItem => {
			// Exact match first, otherwise a plain "my prefix starts with this".
			// The prefix itself is the popup label: that is the text CodeMirror
			// filters against, so a human label there would hide the mnemonic.
			const exactMatch = snippetPrefixKey(snippet.prefix) === key;
			return {
				label: snippet.prefix,
				detail: snippet.label,
				boost: exactMatch ? EXACT_PREFIX_BOOST : PREFIX_MATCH_BOOST,
				type: "snippet",
				exactMatch,
				apply: snippet.body,
			};
		})
		.sort(
			(a, b) =>
				// A shorter prefix wins among equals: `sel` before `select_lock`.
				b.boost - a.boost ||
				a.label.length - b.label.length ||
				a.detail.localeCompare(b.detail),
		);
}

/**
 * Wraps the provider into a CodeMirror `CompletionSource`.
 *
 * `snippetCompletion` is injected rather than imported so this module stays
 * free of a runtime dependency on `@codemirror/autocomplete`, which the editor
 * only ever reaches through its lazy `loadRuntime()`.
 */
export function snippetCompletionSource(
	snippets: () => readonly SqlSnippet[],
	snippetCompletion: (template: string, completion: Completion) => Completion,
): CompletionSource {
	return (context: CompletionContext): CompletionResult | null => {
		const word = context.matchBefore(WORD_BEFORE_CURSOR);
		if (!word) return null;
		const items = buildSnippetCompletions(snippets(), word.text);
		if (items.length === 0) return null;
		return {
			from: word.from,
			options: items.map((item) =>
				snippetCompletion(item.apply, {
					label: item.label,
					detail: item.detail,
					boost: item.boost,
					type: item.type,
				}),
			),
			// While the user keeps typing the same identifier shape, the list we
			// already built is still the right one; no need to re-query.
			validFor: WORD_BEFORE_CURSOR,
		};
	};
}
