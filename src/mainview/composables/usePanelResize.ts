import { ref, type Ref } from "vue";

export interface PanelResizeOptions {
	min: number;
	max: number;
	/**
	 * Which edge of the panel the handle sits on. `"left"` means the panel is
	 * docked to the left of the workspace and its right edge tracks the pointer,
	 * so width grows with `deltaX`. `"right"` is mirrored: the panel is docked
	 * right and its left edge tracks the pointer, so width shrinks with
	 * `deltaX`.
	 */
	side: "left" | "right";
}

const STORAGE_PREFIX = "recall.panel.";

/** Body class from `globals.css` that suppresses selection during a drag. */
const RESIZING_CLASS = "panel-resizing";

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function readStoredWidth(key: string, fallback: number): number {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return fallback;
		const parsed = Number.parseFloat(raw);
		return Number.isFinite(parsed) ? parsed : fallback;
	} catch {
		// Private-mode / disabled storage: fall back silently.
		return fallback;
	}
}

/**
 * Drag-to-resize for a docked panel. The current width is kept in a reactive
 * ref that updates live during the drag; the value is only persisted on
 * pointerup, so a drag that is abandoned never overwrites the stored width.
 *
 * All window listeners and the body class are removed on every exit path
 * (pointerup, pointercancel, blur).
 */
export function usePanelResize(
	storageKey: string,
	initial: number,
	opts?: Partial<PanelResizeOptions>,
): { width: Ref<number>; startResize: (event: PointerEvent) => void } {
	const min = opts?.min ?? 160;
	const max = opts?.max ?? 640;
	const side = opts?.side ?? "left";
	const storageKeyFull = `${STORAGE_PREFIX}${storageKey}`;

	const width = ref(clamp(readStoredWidth(storageKeyFull, initial), min, max));

	function startResize(event: PointerEvent) {
		if (event.button !== 0) return;
		event.preventDefault();

		const startX = event.clientX;
		const startWidth = width.value;
		let frame = 0;
		let pendingX: number | null = null;

		function flush() {
			frame = 0;
			if (pendingX === null) return;
			const delta = pendingX - startX;
			width.value = clamp(
				startWidth + (side === "left" ? delta : -delta),
				min,
				max,
			);
			pendingX = null;
		}

		function handlePointerMove(moveEvent: PointerEvent) {
			pendingX = moveEvent.clientX;
			// rAF-throttled so the drag writes to the reactive ref at most once
			// per frame regardless of pointer event rate.
			if (frame === 0) frame = requestAnimationFrame(flush);
		}

		function cleanup() {
			if (frame !== 0) {
				cancelAnimationFrame(frame);
				frame = 0;
			}
			pendingX = null;
			window.removeEventListener("pointermove", handlePointerMove);
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", handlePointerCancel);
			window.removeEventListener("blur", handlePointerCancel);
			document.body.classList.remove(RESIZING_CLASS);
		}

		function handlePointerUp() {
			flush();
			cleanup();
			try {
				localStorage.setItem(storageKeyFull, String(Math.round(width.value)));
			} catch {
				// Storage unavailable: the resize still applies for this session.
			}
		}

		function handlePointerCancel() {
			cleanup();
		}

		document.body.classList.add(RESIZING_CLASS);
		window.addEventListener("pointermove", handlePointerMove);
		window.addEventListener("pointerup", handlePointerUp);
		window.addEventListener("pointercancel", handlePointerCancel);
		window.addEventListener("blur", handlePointerCancel);
	}

	return { width, startResize };
}
