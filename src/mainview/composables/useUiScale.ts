import { computed, ref, type ComputedRef, type Ref } from "vue";
import { errorMessage, rpc } from "../lib/rpc";
import { toast } from "./useToast";

/**
 * Whole-UI zoom, kept in percent.
 *
 * Percent rather than a multiplier because the step is 5%: `17 * 0.05` is
 * `0.8500000000000001`, and that float would be the value handed to the
 * webview and written to storage. Integers stay exact at every step.
 */
const STORAGE_KEY = "recall.uiScale";
export const UI_SCALE_MIN = 80;
export const UI_SCALE_MAX = 150;
const UI_SCALE_STEP = 5;

/** Clamps into the band and onto the step grid, so a stored 103% reads 105%. */
function snap(percent: number): number {
	const stepped = Math.round(percent / UI_SCALE_STEP) * UI_SCALE_STEP;
	return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, stepped));
}

/** The persisted choice, or 100 when it is absent, blank or unusable. */
function readPersisted(): number {
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(STORAGE_KEY);
	} catch {
		// Storage unavailable: fall through to the default.
	}
	if (raw === null || raw.trim() === "") return 100;
	const stored = Number(raw);
	return Number.isFinite(stored) ? snap(stored) : 100;
}

// Module-level, like `useTheme`: one window, one zoom, and the settings row and
// the startup re-apply must never disagree about it.
const percent = ref(readPersisted());

/**
 * Pushes the current value to the webview. Cheap and idempotent, so startup
 * calls it unconditionally: a fresh webview always begins at 100%.
 */
function apply(): void {
	void rpc.request
		.setUiScale({ scale: percent.value / 100 })
		.catch((err: unknown) => toast(`UI size: ${errorMessage(err)}`));
}

export interface UseUiScale {
	/** Current zoom in percent, always on the step grid. */
	percent: Ref<number>;
	/** False at the top of the band, so the button can disable itself. */
	canIncrease: ComputedRef<boolean>;
	/** False at the bottom of the band. */
	canDecrease: ComputedRef<boolean>;
	/** Re-applies the stored value; call once on startup. */
	apply(): void;
	/** Moves one step, e.g. `step(-1)` for smaller. */
	step(direction: -1 | 1): void;
}

/** Reads and steps the whole-UI zoom level, persisting it and applying it. */
export function useUiScale(): UseUiScale {
	function set(next: number): void {
		const snapped = snap(next);
		if (snapped === percent.value) return;
		percent.value = snapped;
		apply();
		try {
			localStorage.setItem(STORAGE_KEY, String(snapped));
		} catch {
			// Storage unavailable: the zoom still changes for this session.
		}
	}

	return {
		percent,
		canIncrease: computed(() => percent.value < UI_SCALE_MAX),
		canDecrease: computed(() => percent.value > UI_SCALE_MIN),
		apply,
		step: (direction: -1 | 1) => set(percent.value + direction * UI_SCALE_STEP),
	};
}
