/**
 * Mnemonic SQL snippets: the user-editable list behind the editor's completion
 * popup.
 *
 * The list is persisted as a plain array under one key and re-normalised on
 * every read, so a corrupt or hand-edited entry costs that snippet and nothing
 * else. Writes are debounced exactly like the tab store's, because a rename in
 * the settings dialog and a completion-driven read can otherwise interleave.
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import {
	createSnippetId,
	DEFAULT_SQL_SNIPPETS,
	normalizeSnippets,
	snippetPrefixKey,
	type SqlSnippet,
} from "../lib/sqlSnippets";

const STORAGE_KEY = "recall.snippets";
const PERSIST_DEBOUNCE_MS = 300;

/** Fields a caller may set when creating a snippet; the id is ours. */
export type SnippetInput = Omit<SqlSnippet, "id">;
/** A patch may not rename the prefix to something that collides. */
export type SnippetPatch = Partial<Omit<SqlSnippet, "id">>;
/**
 * Why a write was rejected. Every variant is a user-fixable input problem, so
 * the settings dialog can point at the offending field instead of toasting.
 */
export type SnippetWriteFailure =
	| "empty-prefix"
	| "duplicate-prefix"
	| "empty-body"
	| "missing-snippet";

export type SnippetWriteResult =
	| { ok: true; snippet: SqlSnippet }
	| { ok: false; reason: SnippetWriteFailure };

/** Returns the defaults, cloned so callers cannot mutate the shared table. */
function defaultSnippets(): SqlSnippet[] {
	return DEFAULT_SQL_SNIPPETS.map((snippet) => ({ ...snippet }));
}

/**
 * Reads the persisted list, or the built-ins on a first run.
 *
 * `normalizeSnippets` never throws and falls back to the built-ins when nothing
 * usable survives, so an unreadable store degrades to a working editor rather
 * than an empty popup.
 */
function readPersisted(): SqlSnippet[] {
	let raw: string | null;
	try {
		raw = localStorage.getItem(STORAGE_KEY);
	} catch {
		return defaultSnippets();
	}
	if (raw === null) return defaultSnippets();
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return defaultSnippets();
	}
	return normalizeSnippets(parsed);
}

export const useSnippetsStore = defineStore("snippets", () => {
	const snippets = ref<SqlSnippet[]>(readPersisted());

	/** Only what the editor may offer; disabled snippets stay in the list. */
	const enabledSnippets = computed(() =>
		snippets.value.filter((snippet) => snippet.enabled),
	);

	let persistTimer: ReturnType<typeof setTimeout> | undefined;
	watch(
		[snippets],
		() => {
			clearTimeout(persistTimer);
			persistTimer = setTimeout(() => {
				try {
					localStorage.setItem(
						STORAGE_KEY,
						JSON.stringify(snippets.value),
					);
				} catch {
					// Storage unavailable or full: snippets live for this
					// session only, which is better than losing the edit.
				}
			}, PERSIST_DEBOUNCE_MS);
		},
		{ deep: true },
	);

	/**
	 * Applies the shared prefix rules: non-empty after trimming, and unique
	 * across the whole list. `exceptId` lets an edit keep its own prefix.
	 *
	 * A collision with a built-in is reported, never silently resolved — the
	 * user decides whether to rename or to delete the built-in.
	 */
	function prefixProblem(
		prefix: string,
		exceptId?: string,
	): SnippetWriteFailure | null {
		const key = snippetPrefixKey(prefix);
		if (!key) return "empty-prefix";
		const clash = snippets.value.some(
			(snippet) =>
				snippet.id !== exceptId && snippetPrefixKey(snippet.prefix) === key,
		);
		return clash ? "duplicate-prefix" : null;
	}

	function add(input: SnippetInput): SnippetWriteResult {
		const prefix = input.prefix.trim();
		const problem = prefixProblem(prefix);
		if (problem) return { ok: false, reason: problem };
		const body = input.body.trim();
		if (!body) return { ok: false, reason: "empty-body" };
		const label = input.label.trim() || prefix;
		const snippet: SqlSnippet = {
			id: createSnippetId(),
			label,
			prefix,
			body,
			enabled: input.enabled,
		};
		snippets.value = [...snippets.value, snippet];
		return { ok: true, snippet };
	}

	function update(id: string, patch: SnippetPatch): SnippetWriteResult {
		const existing = snippets.value.find((snippet) => snippet.id === id);
		if (!existing) return { ok: false, reason: "missing-snippet" };
		const prefix = patch.prefix === undefined ? existing.prefix : patch.prefix.trim();
		const problem = prefixProblem(prefix, id);
		if (problem) return { ok: false, reason: problem };
		const body = patch.body === undefined ? existing.body : patch.body.trim();
		if (!body) return { ok: false, reason: "empty-body" };
		const label =
			patch.label === undefined ? existing.label : patch.label.trim() || prefix;
		const snippet: SqlSnippet = {
			...existing,
			label,
			prefix,
			body,
			enabled: patch.enabled ?? existing.enabled,
		};
		snippets.value = snippets.value.map((entry) =>
			entry.id === id ? snippet : entry,
		);
		return { ok: true, snippet };
	}

	function remove(id: string): void {
		snippets.value = snippets.value.filter((snippet) => snippet.id !== id);
	}

	function toggleEnabled(id: string): void {
		snippets.value = snippets.value.map((snippet) =>
			snippet.id === id ? { ...snippet, enabled: !snippet.enabled } : snippet,
		);
	}

	/**
	 * Throws away every customisation, including deleted and renamed built-ins.
	 * The settings dialog puts a confirmation in front of this.
	 */
	function resetToDefaults(): void {
		snippets.value = defaultSnippets();
	}

	return {
		snippets,
		enabledSnippets,
		add,
		update,
		remove,
		toggleEnabled,
		resetToDefaults,
	};
});
