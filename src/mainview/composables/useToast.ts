import { readonly, ref } from "vue";

export interface ToastAction {
	label: string;
	run(): void;
}

/**
 * Single-toast state. Deliberately module-level rather than provided by a
 * component: any module (store, composable, plain helper) can raise a toast
 * without a provider in the tree.
 */
const message = ref("");
const visible = ref(false);
const action = ref<ToastAction | null>(null);
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function clearTimers() {
	clearTimeout(hideTimer);
	hideTimer = undefined;
}

/** Hides the toast now, cancelling any pending auto-hide. */
function dismissToast() {
	clearTimers();
	action.value = null;
	visible.value = false;
}

/**
 * Shows `newMessage`, replacing any toast already on screen. Calling this again
 * before the previous toast expires restarts its timer instead of stacking.
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
	};
}
