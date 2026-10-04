/**
 * Shared dirty-close queue.
 *
 * Closing a tab that holds unsaved SQL is a question, not an action: the tab
 * has to stay open until the user answers. That question used to live inside
 * the tab strip, which meant the only way to raise it was clicking a pill or
 * picking "Close others". Moving it here lets a window-level shortcut raise
 * the very same question, and — because the queue is module-level — makes both
 * callers share one queue and one dialog instead of racing two of them.
 *
 * The store is resolved inside `useTabClose()` rather than at module scope:
 * Pinia requires an active app context, and a module-level `useStore()` would
 * throw the moment the file was imported.
 */
import { computed, ref, watch } from "vue";
import type { ComputedRef, Ref, WritableComputedRef } from "vue";
import { useTabsStore } from "../stores/tabs";

/**
 * Ids awaiting the unsaved-changes answer; dirty tabs are held back until then.
 * Module-level so the strip, its context menu and the shortcut dispatcher all
 * act on the same queue.
 */
const pendingIds = ref<string[]>([]);

/**
 * Tab-close state and controls for whoever is asking to close something.
 *
 * Safe to call outside a component setup: there is no lifecycle hook and no
 * injection, and every caller sees the same shared queue.
 */
export function useTabClose(): {
	pendingIds: Readonly<Ref<string[]>>;
	pendingTitles: ComputedRef<string[]>;
	dialogOpen: WritableComputedRef<boolean>;
	requestClose: (tabId: string) => void;
	requestCloseOthers: (tabId: string) => void;
	requestCloseAll: () => void;
	cancel: () => void;
	discardAndClose: () => void;
	saveAndClose: () => void;
} {
	const tabs = useTabsStore();

	/** Titles of the queued tabs, for naming them in the confirmation. */
	const pendingTitles = computed(() =>
		tabs.tabs
			.filter((tab) => pendingIds.value.includes(tab.id))
			.map((tab) => tab.title),
	);

	/**
	 * The confirmation is open exactly while something is queued, so the dialog
	 * has no separate boolean to fall out of sync with the queue. Closing it
	 * (Escape, overlay click, Cancel) is the same as dismissing the question.
	 */
	const dialogOpen = computed<boolean>({
		get: () => pendingIds.value.length > 0,
		set: (open: boolean) => {
			if (!open) pendingIds.value = [];
		},
	});

	/**
	 * Closes one tab, queueing it for confirmation when it still holds unsaved
	 * SQL. A tab that is already gone is a no-op: someone else closed it.
	 */
	function requestClose(tabId: string): void {
		const result = tabs.close(tabId);
		if (result.closed) return;
		if (result.reason === "dirty") pendingIds.value = [tabId];
	}

	/**
	 * Keeps `tabId` and sweeps the rest, activating the survivor first because
	 * right-clicking a tab is how the user points at the one they mean to keep.
	 * Dirty tabs survive the sweep and are queued for confirmation.
	 */
	function requestCloseOthers(tabId: string): void {
		tabs.activate(tabId);
		const { dirtyIds } = tabs.closeOthers(tabId);
		pendingIds.value = dirtyIds;
	}

	/**
	 * Closes everything that can be closed without asking. `closeOthers` cannot
	 * be reused here — it is keyed on a survivor, and close-all has none — so
	 * this walks the strip itself: clean tabs go immediately, dirty ones are
	 * collected and left standing behind a single question.
	 */
	function requestCloseAll(): void {
		const dirty: string[] = [];
		for (const tab of tabs.tabs) {
			if (tabs.isDirty(tab)) {
				dirty.push(tab.id);
				continue;
			}
			tabs.close(tab.id, { force: true });
		}
		pendingIds.value = dirty;
	}

	/** Dismisses the question; every queued tab stays open. */
	function cancel(): void {
		pendingIds.value = [];
	}

	/** Closes the queued tabs without saving them. */
	function discardAndClose(): void {
		for (const id of pendingIds.value) tabs.close(id, { force: true });
		pendingIds.value = [];
	}

	/**
	 * Closes the queued tabs after recording their SQL as the saved baseline.
	 * The queue is emptied before the loop so the dialog is gone even if a tab
	 * was closed out from under us partway through.
	 */
	function saveAndClose(): void {
		const ids = [...pendingIds.value];
		pendingIds.value = [];
		for (const id of ids) {
			tabs.markSaved(id);
			tabs.close(id);
		}
	}

	// A connection going away can close the tab out from under the dialog.
	watch(
		() => tabs.tabs,
		(list) => {
			const live = new Set(list.map((tab) => tab.id));
			pendingIds.value = pendingIds.value.filter((id) => live.has(id));
		},
	);

	return {
		pendingIds,
		pendingTitles,
		dialogOpen,
		requestClose,
		requestCloseOthers,
		requestCloseAll,
		cancel,
		discardAndClose,
		saveAndClose,
	};
}