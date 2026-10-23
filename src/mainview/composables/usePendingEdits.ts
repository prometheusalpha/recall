/**
 * Staged cell edits for one result grid. The map is replaced on every change
 * rather than mutated, so a `shallowRef` is enough to repaint the cells.
 */

import { computed, shallowRef } from "vue";
import { editKey, editsByRow, type PendingEdit } from "../lib/pendingEdits";

export function usePendingEdits() {
	const edits = shallowRef(new Map<string, PendingEdit>());

	const count = computed(() => edits.value.size);

	function has(row: number, resultCol: number): boolean {
		return edits.value.has(editKey(row, resultCol));
	}

	function get(row: number, resultCol: number): PendingEdit | undefined {
		return edits.value.get(editKey(row, resultCol));
	}

	function set(row: number, resultCol: number, value: unknown): void {
		const next = new Map(edits.value);
		next.set(editKey(row, resultCol), { row, resultCol, value });
		edits.value = next;
	}

	function remove(row: number, resultCol: number): void {
		const key = editKey(row, resultCol);
		if (!edits.value.has(key)) return;
		const next = new Map(edits.value);
		next.delete(key);
		edits.value = next;
	}

	function clear(): void {
		if (edits.value.size > 0) edits.value = new Map();
	}

	function grouped() {
		return editsByRow(edits.value.values());
	}

	return { count, has, get, set, remove, clear, grouped };
}
