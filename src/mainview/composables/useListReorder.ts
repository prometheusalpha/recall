/**
 * Vertical drag-to-reorder for a list of rows, by PointerEvents like the grid
 * header and the tab strip, so the drop is decided against live row geometry.
 *
 * Built for rows inside a `reka` menu, which acts on its own pointer events:
 * a release over an item clicks it. The release and the click that follows are
 * therefore caught in the capture phase and stopped, or ending a drag would
 * also toggle whichever row it ended on.
 */
import { onBeforeUnmount, ref } from "vue";

/** Vertical travel before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;
/** How close to the list's top or bottom edge the pointer scrolls it. */
const EDGE_SCROLL_PX = 24;
const EDGE_SCROLL_STEP = 8;

interface DragSession {
	pointerId: number;
	from: number;
	startY: number;
	active: boolean;
	drop: number;
	list: HTMLElement;
}

export function useListReorder(options: {
	/** Matches every row of the list, in order, inside the list element. */
	rowSelector: string;
	/** Matches the scrolling element that holds the rows. */
	listSelector: string;
	onReorder: (from: number, to: number) => void;
}) {
	/** Index of the row being dragged, once the threshold is crossed. */
	const dragging = ref<number | null>(null);
	/** The row the drop rule is drawn on, and on which edge. */
	const dropMarker = ref<{ index: number; edge: "top" | "bottom" } | null>(null);

	let session: DragSession | null = null;

	function start(event: PointerEvent, index: number): void {
		if (event.button !== 0 || session) return;
		const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		const list = handle?.closest<HTMLElement>(options.listSelector);
		if (!list) return;
		// Kept from the item underneath, which would otherwise read the press as
		// the start of a click; the default is what starts a text selection.
		event.stopPropagation();
		event.preventDefault();
		session = {
			pointerId: event.pointerId,
			from: index,
			startY: event.clientY,
			active: false,
			drop: index,
			list,
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp, { capture: true });
		window.addEventListener("pointercancel", cleanup);
		window.addEventListener("keydown", onKeydown, { capture: true });
	}

	/**
	 * How many of the *other* rows the pointer is below the midpoint of: the
	 * index the row takes in the list with itself removed, so dropping it back
	 * on its own slot compares equal to `from`.
	 */
	function dropIndexFor(clientY: number, from: number, list: HTMLElement): number {
		const rows = list.querySelectorAll<HTMLElement>(options.rowSelector);
		let index = 0;
		for (const [position, row] of rows.entries()) {
			if (position === from) continue;
			const rect = row.getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) break;
			index += 1;
		}
		return index;
	}

	function onMove(event: PointerEvent): void {
		if (!session || event.pointerId !== session.pointerId) return;
		if (!session.active) {
			if (Math.abs(event.clientY - session.startY) <= DRAG_THRESHOLD_PX) return;
			session.active = true;
			dragging.value = session.from;
		}
		const bounds = session.list.getBoundingClientRect();
		if (event.clientY < bounds.top + EDGE_SCROLL_PX) session.list.scrollTop -= EDGE_SCROLL_STEP;
		else if (event.clientY > bounds.bottom - EDGE_SCROLL_PX) session.list.scrollTop += EDGE_SCROLL_STEP;

		const { from, list } = session;
		const drop = dropIndexFor(event.clientY, from, list);
		session.drop = drop;
		if (drop === from) {
			dropMarker.value = null;
			return;
		}
		// The rule sits on the row the drop displaces, read from the list that
		// still holds the dragged row, hence one further along past the source.
		const count = list.querySelectorAll(options.rowSelector).length;
		const target = drop + (drop >= from ? 1 : 0);
		dropMarker.value =
			target >= count ? { index: count - 1, edge: "bottom" } : { index: target, edge: "top" };
	}

	function onUp(event: PointerEvent): void {
		if (!session || event.pointerId !== session.pointerId) return;
		event.stopPropagation();
		const { active, from, drop } = session;
		cleanup();
		if (!active) return;
		// The click that follows a release is swallowed once, then the listener
		// goes; a timer rather than `once` because no click comes when the press
		// and release landed on different rows.
		const swallow = (click: MouseEvent): void => {
			click.stopPropagation();
			click.preventDefault();
		};
		window.addEventListener("click", swallow, { capture: true, once: true });
		window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
		if (drop !== from) options.onReorder(from, drop);
	}

	/** Escape cancels the drag only, rather than closing the menu under it. */
	function onKeydown(event: KeyboardEvent): void {
		if (event.key !== "Escape" || !session?.active) return;
		event.stopPropagation();
		event.preventDefault();
		cleanup();
	}

	function cleanup(): void {
		session = null;
		dragging.value = null;
		dropMarker.value = null;
		window.removeEventListener("pointermove", onMove);
		window.removeEventListener("pointerup", onUp, { capture: true });
		window.removeEventListener("pointercancel", cleanup);
		window.removeEventListener("keydown", onKeydown, { capture: true });
	}

	onBeforeUnmount(cleanup);

	return { dragging, dropMarker, start };
}
