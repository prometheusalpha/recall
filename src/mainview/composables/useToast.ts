import { readonly, ref } from "vue";

export interface ToastAction {
	label: string;
	run(): void;
}

/**
 * Single-toast state. Deliberately module-level rather than provided by a
 * component: any module (store, composable, plain helper) can raise a toast
 * without a provider in the tree.
 *
 * Auto-hide is suspendable, so a toast the user is still reading cannot vanish
 * mid-sentence. `hold()` clears the one pending `hideTimer` and records that the
 * current toast is held; `release()` arms a fresh FULL delay rather than the
 * remaining time, which is what makes "expand, read it, collapse, still get the
 * whole grace period" predictable. A fresh `toast()` and a dismissal both clear
 * the hold, so a toast never comes back held behind the user's back. A sticky
 * toast (`durationMs === 0`) has no timer at all: holding and releasing it are
 * harmless no-ops and it stays up until dismissed.
 */
const message = ref("");
const visible = ref(false);
const action = ref<ToastAction | null>(null);
let hideTimer: ReturnType<typeof setTimeout> | undefined;
/** Auto-hide delay of the toast currently on screen; `0` means sticky. */
let currentDurationMs = 0;
/** True while `hold()` has suspended auto-hide for the current toast. */
let held = false;

function clearTimers() {
	clearTimeout(hideTimer);
	hideTimer = undefined;
}

/** Hides the toast now, cancelling any pending auto-hide. */
function dismissToast() {
	clearTimers();
	held = false;
	action.value = null;
	visible.value = false;
}

/**
 * Suspends auto-hide without hiding the toast, so the caller can present more of
 * the message than the collapsed toast shows. Idempotent: a second call only
 * re-clears the already cleared timer.
 */
function holdToast(): void {
	clearTimers();
	held = true;
}

/**
 * Resumes auto-hide for a held toast with a fresh full delay. A sticky toast has
 * no delay to restart and simply stays up.
 */
function releaseToast(): void {
	if (!held) return;
	held = false;
	clearTimers();
	if (currentDurationMs > 0) {
		hideTimer = setTimeout(dismissToast, currentDurationMs);
	}
}

/**
 * Shows `newMessage`, replacing any toast already on screen. Calling this again
 * before the previous toast expires restarts its timer instead of stacking, and
 * clears any hold — a new toast owns its whole lifetime again.
 *
 * @param durationMs Auto-hide delay; `0` keeps the toast up until dismissed.
 * @param newAction Optional single action button.
 */
export function toast(
	newMessage: string,
	durationMs = 4000,
	newAction?: ToastAction,
): void {
	clearTimers();
	held = false;
	currentDurationMs = durationMs;
	message.value = newMessage;
	action.value = newAction ?? null;
	visible.value = true;
	if (durationMs > 0) {
		hideTimer = setTimeout(dismissToast, durationMs);
	}
}

/**
 * Toast state and controls. Safe to call outside a component setup — there is
 * no lifecycle hook, no injection, and no per-call state.
 */
export function useToast() {
	return {
		message: readonly(message),
		visible: readonly(visible),
		action: readonly(action),
		toast,
		dismiss: dismissToast,
		/** Suspends auto-hide without hiding the toast. Idempotent. */
		hold: holdToast,
		/** Resumes auto-hide with a fresh full delay, or does nothing if there is no delay. */
		release: releaseToast,
	};
}