<script setup lang="ts">
/**
 * Tab strip.
 *
 * Pinned tabs render first, then a 1px separator, then the rest — the same
 * two-section strip the reference app uses. Reordering is PointerEvents-based
 * rather than HTML5 drag-and-drop, so a drop can be decided against live DOM
 * geometry and the strip's own scrolling keeps working.
 */
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { PinIcon, PlusIcon, XIcon } from "lucide-vue-next";
import { useTabsStore } from "../../stores/tabs";
import type { Tab } from "../../stores/tabs";
import { useTabClose } from "../../composables/useTabClose";
import CustomContextMenu from "../ui/CustomContextMenu.vue";
import type { ContextMenuItem } from "../ui/CustomContextMenu.vue";
import { Separator } from "../ui/separator";
import { Button } from "../ui/button";

const emit = defineEmits<{
	/** The user asked for a fresh query tab. */
	"new-tab": [];
}>();

const tabsStore = useTabsStore();

/** Horizontal travel before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;

type StripEntry =
	| { kind: "tab"; tab: Tab }
	| { kind: "separator"; key: string };

const pinnedTabs = computed(() => tabsStore.tabs.filter((tab) => tab.pinned));
const otherTabs = computed(() => tabsStore.tabs.filter((tab) => !tab.pinned));
const entries = computed<StripEntry[]>(() => [
	...pinnedTabs.value.map((tab) => ({ kind: "tab" as const, tab })),
	...(pinnedTabs.value.length > 0 && otherTabs.value.length > 0
		? [{ kind: "separator" as const, key: "separator" }]
		: []),
	...otherTabs.value.map((tab) => ({ kind: "tab" as const, tab })),
]);

const activeId = computed(() => tabsStore.activeTabId);

function isDirty(tab: Tab): boolean {
	return tabsStore.isDirty(tab);
}

/* -------------------------------------------------------------------------
 * Pointer drag reorder
 * ---------------------------------------------------------------------- */

const draggingTabId = ref<string | null>(null);
const dropTargetId = ref<string | null>(null);
const dropPosition = ref<"before" | "after" | null>(null);
const suppressNextClick = ref(false);

interface DragSession {
	pointerId: number;
	startX: number;
	startY: number;
	tabId: string;
	active: boolean;
	targetId: string | null;
	position: "before" | "after" | null;
}

let drag: DragSession | null = null;

function onPillPointerDown(event: PointerEvent, tab: Tab): void {
	if (event.button !== 0) return;
	// A second pointer device must not hijack a live drag.
	if (drag) return;
	// Presses that start on a control belong to the control.
	if (
		event.target instanceof Element &&
		event.target.closest("button, input, [role='button']")
	) {
		return;
	}
	// Touch owns the gesture; the strip's native scroll needs it.
	if (event.pointerType === "touch") return;
	// macOS reports a trackpad tap as button=0 with buttons=0: a click.
	if ((event.buttons & 1) !== 1) return;

	drag = {
		pointerId: event.pointerId,
		startX: event.clientX,
		startY: event.clientY,
		tabId: tab.id,
		active: false,
		targetId: null,
		position: null,
	};
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", onPointerUp);
	window.addEventListener("pointercancel", cleanupDrag);
	window.addEventListener("blur", cleanupDrag);
}

function onPointerMove(event: PointerEvent): void {
	if (!drag) return;
	if (event.pointerId !== drag.pointerId) return;
	if ((event.buttons & 1) !== 1) {
		cleanupDrag();
		return;
	}
	if (!drag.active) {
		if (Math.abs(event.clientX - drag.startX) <= DRAG_THRESHOLD_PX) return;
		drag.active = true;
		draggingTabId.value = drag.tabId;
		// The pointerup that ends the drag is followed by a click; eat it.
		suppressNextClick.value = true;
	}
	event.preventDefault();

	const under = document.elementFromPoint(event.clientX, event.clientY);
	const pill =
		under instanceof Element ? under.closest<HTMLElement>("[data-tab-id]") : null;
	const targetId = pill?.dataset.tabId ?? null;
	// Dropping onto the source itself is a no-op in the store; show no marker.
	if (!pill || !targetId || targetId === drag.tabId) {
		drag.targetId = null;
		drag.position = null;
		dropTargetId.value = null;
		dropPosition.value = null;
		return;
	}
	const rect = pill.getBoundingClientRect();
	drag.targetId = targetId;
	drag.position = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
	dropTargetId.value = targetId;
	dropPosition.value = drag.position;
}

function onPointerUp(event: PointerEvent): void {
	if (!drag) return;
	if (event.pointerId !== drag.pointerId) return;
	const { active, tabId, targetId, position } = drag;
	cleanupDrag();
	if (!active || !targetId || !position) return;
	event.preventDefault();
	tabsStore.reorder(tabId, targetId, position);
}

function cleanupDrag(): void {
	window.removeEventListener("pointermove", onPointerMove);
	window.removeEventListener("pointerup", onPointerUp);
	window.removeEventListener("pointercancel", cleanupDrag);
	window.removeEventListener("blur", cleanupDrag);
	drag = null;
	draggingTabId.value = null;
	dropTargetId.value = null;
	dropPosition.value = null;
	// A drag that ends outside a pill may never produce a click to swallow.
	if (suppressNextClick.value) {
		window.setTimeout(() => {
			suppressNextClick.value = false;
		}, 0);
	}
}

function onPillClick(tab: Tab): void {
	if (suppressNextClick.value) {
		suppressNextClick.value = false;
		return;
	}
	tabsStore.activate(tab.id);
}

onBeforeUnmount(() => {
	window.removeEventListener("pointermove", onPointerMove);
	window.removeEventListener("pointerup", onPointerUp);
	window.removeEventListener("pointercancel", cleanupDrag);
	window.removeEventListener("blur", cleanupDrag);
});

/* -------------------------------------------------------------------------
 * Dirty-close confirmation
 * ---------------------------------------------------------------------- */

// The queue and its dialog are shared with the rest of the window, so that a
// keyboard shortcut raising the same question reuses this one prompt.
const { requestClose, requestCloseOthers } = useTabClose();

/* -------------------------------------------------------------------------
 * Context menu and inline rename
 * ---------------------------------------------------------------------- */

const menuTabId = ref<string | null>(null);
/**
 * Items handed to the one shared `CustomContextMenu` host. Rebuilt on every
 * open so a tab's pinned state and "close others" availability are read at the
 * moment of the right-click rather than from an array built for an earlier tab.
 */
const menuItems = ref<ContextMenuItem[]>([]);
const menuTab = computed(
	() => tabsStore.tabs.find((tab) => tab.id === menuTabId.value) ?? null,
);

function onPillContextMenu(
	tab: Tab,
	event: MouseEvent,
	openMenu: (event: MouseEvent, items?: ContextMenuItem[]) => void,
): void {
	menuTabId.value = tab.id;
	menuItems.value = tabMenuItems();
	// Pass the just-built array through as the open-call override so the open
	// and the prop update share one event turn.
	openMenu(event, menuItems.value);
}

/**
 * The actions a tab pill offers. Rename and Pin lead; "Close others" is the
 * only one that acts on a sibling, so a separator sets it apart.
 */
function tabMenuItems(): ContextMenuItem[] {
	const tab = menuTab.value;
	return [
		{ label: "Rename", disabled: !tab, action: startRename },
		{
			label: tab?.pinned ? "Unpin" : "Pin",
			disabled: !tab,
			action: toggleMenuPin,
		},
		{ label: "", separator: true },
		{
			label: "Close others",
			disabled: !canCloseOthers.value,
			action: closeMenuOthers,
		},
	];
}

const editingTabId = ref<string | null>(null);
const renameDraft = ref("");
const renameInputEl = ref<HTMLInputElement | null>(null);

/** Function ref: the input lives inside a `v-for`, so a template ref would array-ify. */
function setRenameInput(el: unknown): void {
	renameInputEl.value = el instanceof HTMLInputElement ? el : null;
}

async function startRename(): Promise<void> {
	const tab = menuTab.value;
	if (!tab) return;
	editingTabId.value = tab.id;
	renameDraft.value = tab.title;
	await nextTick();
	const input = renameInputEl.value;
	if (!input) return;
	input.focus();
	input.select();
}

function commitRename(): void {
	const id = editingTabId.value;
	if (!id) return;
	const title = renameDraft.value.trim();
	if (title.length > 0) tabsStore.rename(id, title);
	editingTabId.value = null;
}

function cancelRename(): void {
	editingTabId.value = null;
}

function toggleMenuPin(): void {
	const tab = menuTab.value;
	if (tab) tabsStore.togglePin(tab.id);
}

/** Pointless with one tab open: "close others" would close nothing. */
const canCloseOthers = computed(
	() => menuTab.value !== null && tabsStore.tabs.length > 1,
);

function closeMenuOthers(): void {
	const tab = menuTab.value;
	if (!tab) return;
	// The shared host has already closed the menu by the time this runs, so it
	// is not competing with the dialog for focus.
	requestCloseOthers(tab.id);
}
</script>

<template>
	<div
		class="tab-strip relative border-b border-border"
		role="tablist"
		aria-label="Open tabs"
	>
		<!-- One menu for every pill: the host is shared so a strip of many tabs
		     carries one menu, not one per pill. -->
		<CustomContextMenu :items="menuItems" v-slot="contextMenuSlot">
			<template v-for="entry in entries" :key="entry.kind === 'tab' ? entry.tab.id : entry.key">
				<Separator
					v-if="entry.kind === 'separator'"
					orientation="vertical"
					class="mx-0.5 h-4 self-center"
				/>
				<div
					v-else
					class="tab-pill"
					role="tab"
					:data-tab-id="entry.tab.id"
					:data-active="entry.tab.id === activeId"
					:data-dragging="draggingTabId === entry.tab.id"
					:data-drop-before="dropTargetId === entry.tab.id && dropPosition === 'before'"
					:data-drop-after="dropTargetId === entry.tab.id && dropPosition === 'after'"
					:aria-selected="entry.tab.id === activeId"
					:title="entry.tab.title"
					tabindex="0"
					@pointerdown="onPillPointerDown($event, entry.tab)"
					@click="onPillClick(entry.tab)"
					@keydown.enter.prevent="onPillClick(entry.tab)"
					@keydown.space.prevent="onPillClick(entry.tab)"
					@contextmenu="
						onPillContextMenu(entry.tab, $event, contextMenuSlot.onContextMenu)
					"
				>
					<PinIcon
						v-if="entry.tab.pinned"
						class="size-3 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<input
						v-if="editingTabId === entry.tab.id"
						:ref="setRenameInput"
						v-model="renameDraft"
						type="text"
						class="w-28 rounded-sm border border-border bg-background px-1 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
						style="user-select: text"
						aria-label="Tab title"
						@click.stop
						@pointerdown.stop
						@keydown.enter.stop.prevent="commitRename"
						@keydown.esc.stop.prevent="cancelRename"
						@keydown.space.stop
						@blur="commitRename"
					/>
					<span v-else class="min-w-0 grow truncate">
						{{ entry.tab.title }}{{ isDirty(entry.tab) ? "*" : "" }}
					</span>

					<template v-if="editingTabId !== entry.tab.id">
						<button
							type="button"
							class="tab-close"
							:aria-label="`Close ${entry.tab.title}`"
							@click.stop="requestClose(entry.tab.id)"
						>
							<XIcon class="size-3" aria-hidden="true" />
						</button>
					</template>
				</div>
			</template>

			<!-- `self-center` because the strip stretches its children: a sized
			     button would otherwise sit on the top edge instead of on the
			     pills' optical centre. -->
			<Button
				variant="ghost"
				size="icon-sm"
				class="shrink-0 self-center"
				aria-label="New query tab"
				@click="emit('new-tab')"
			>
				<PlusIcon aria-hidden="true" />
			</Button>
		</CustomContextMenu>
	</div>
</template>
