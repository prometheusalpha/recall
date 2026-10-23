/**
 * The grid's column-order overlay as plain list operations, so the header drag
 * and the Columns menu drag write one order and can never disagree.
 *
 * The overlay holds *every* column, hidden ones included: a column hidden and
 * shown again comes back where it was, not appended to the end.
 */

/**
 * Every result column in display order. Overlay names the result no longer has
 * are dropped; result columns the overlay never saw keep their own order at the
 * end.
 */
export function fullColumnOrder(overlay: string[], resultColumns: string[]): string[] {
	const live = new Set(resultColumns);
	const kept = overlay.filter((name) => live.has(name));
	const placed = new Set(kept);
	return [...kept, ...resultColumns.filter((name) => !placed.has(name))];
}

/**
 * Writes a new order of the visible columns back into the full order. Each slot
 * a visible column held takes the next name of `visible`; hidden columns keep
 * their slots.
 */
export function mergeVisibleOrder(full: string[], visible: string[]): string[] {
	const shown = new Set(visible);
	let cursor = 0;
	return full.map((name) => (shown.has(name) ? (visible[cursor++] ?? name) : name));
}

/** `list` with the item at `from` moved to `to`, both indexes into `list`. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
	if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
	const next = [...list];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved as T);
	return next;
}
