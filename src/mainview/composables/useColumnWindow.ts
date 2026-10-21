/**
 * Which columns the result grid's rows render, kept in step with the scroller.
 *
 * Scroll offsets are held outside Vue on purpose: the window ref is written
 * only when the rendered range actually changes, so a horizontal scroll inside
 * the buffer costs no re-render, and a vertical one never touches it.
 */

import { computed, shallowRef, watch } from "vue";
import {
	columnOffsets,
	columnWindow,
	includeColumn,
	sameWindow,
	type ColumnWindow,
} from "../lib/columnWindow";

export interface ColumnWindowOptions {
	/** Width of each visible column, in render order. */
	widths: () => readonly number[];
	/** Width of the sticky gutter left of the columns. */
	gutter: number;
	buffer: number;
	/** A column that must stay rendered wherever the scroll is (an open editor). */
	pinnedColumn: () => number | null;
}

export function useColumnWindow(options: ColumnWindowOptions) {
	const offsets = computed(() => columnOffsets(options.widths()));
	let scrollLeft = 0;
	let viewportWidth = 0;
	const scrolled = shallowRef<ColumnWindow>({ start: 0, end: 0, before: 0 });

	function recompute(): void {
		const next = columnWindow({
			offsets: offsets.value,
			scrollLeft,
			viewportWidth,
			gutter: options.gutter,
			buffer: options.buffer,
		});
		if (!sameWindow(next, scrolled.value)) scrolled.value = next;
	}

	/** Called on every scroll and resize; cheap when nothing moved far enough. */
	function update(left: number, width: number): void {
		scrollLeft = left;
		viewportWidth = width;
		recompute();
	}

	watch(offsets, recompute, { immediate: true });

	const range = computed(() => {
		const pinned = options.pinnedColumn();
		return pinned === null
			? scrolled.value
			: includeColumn(scrolled.value, pinned, offsets.value);
	});

	/** Visible column indexes to render, in order. */
	const renderedColumns = computed(() => {
		const { start, end } = range.value;
		return Array.from({ length: end - start }, (_, i) => start + i);
	});

	function isRendered(col: number): boolean {
		return col >= range.value.start && col < range.value.end;
	}

	return { range, renderedColumns, isRendered, update };
}
