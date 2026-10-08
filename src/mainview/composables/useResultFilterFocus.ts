/**
 * Focus handoff for the result filter bar's WHERE box.
 *
 * The Cmd/Ctrl+L chord is owned by the window shell (`App.vue`), but the input
 * it has to focus lives several components down inside a `ResultGrid`. The two
 * cannot see each other, so the grid publishes the one callback that moves
 * focus and the shell calls it through the command registry. Module-level like
 * `useQuickOpen`: both grid branches (`table` and `query`) are mutually
 * exclusive, so exactly one grid — and one filter bar — is on screen at a time.
 *
 * The callback answers with whether it actually moved focus. A query tab has no
 * WHERE box to focus, and a chord the app is not acting on must be left to the
 * webview rather than swallowed — the shell turns a `false` into "not handled".
 */

/** The published callback, or null when no grid is mounted. */
let focusWhere: (() => boolean) | null = null;

/**
 * Registers the on-screen filter bar's focus callback and returns the inverse.
 *
 * The release is guarded by identity so an unmounting grid can never clear a
 * callback a newer grid has already installed — the two branches can overlap
 * for a frame during a tab switch.
 */
export function registerResultFilterFocus(callback: () => boolean): () => void {
	focusWhere = callback;
	return () => {
		if (focusWhere === callback) focusWhere = null;
	};
}

/** False when no filter bar is on screen, so the shell does not claim the chord. */
export function focusResultFilter(): boolean {
	if (focusWhere === null) return false;
	return focusWhere();
}
