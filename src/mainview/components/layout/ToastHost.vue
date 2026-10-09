<script setup lang="ts">
import { ChevronDown, ChevronUp, X } from "lucide-vue-next";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useToast } from "../../composables/useToast";

const { message, visible, action, dismiss, hold, release } = useToast();

/** True while the toast shows the message unclamped, scrolled up to 60vh. */
const expanded = ref(false);
/** Whether the clamped message has more content than it can show. */
const overflows = ref(false);
const messageEl = ref<HTMLSpanElement | null>(null);

/**
 * A clamped span hides the fact that it is hiding something, so the expand
 * affordance is shown only when the text genuinely does not fit. Measured after
 * layout settles, since `scrollHeight` is meaningless before the span has a box.
 */
async function measure(): Promise<void> {
	await nextTick();
	const el = messageEl.value;
	overflows.value = !!el && el.scrollHeight > el.clientHeight + 1;
}

/** Runs the toast's single action, then clears the toast it belongs to. */
function runAction(): void {
	action.value?.run();
	dismiss();
}

/** A window shrink can make the clamped text fit again — re-measure it. */
function onResize(): void {
	void measure();
}

onMounted(() => window.addEventListener("resize", onResize));
onBeforeUnmount(() => window.removeEventListener("resize", onResize));

// A new toast must not inherit the previous one's expansion or its chevron.
watch(visible, async (shown) => {
	if (!shown) return;
	expanded.value = false;
	overflows.value = false;
	await measure();
});
watch(message, measure);
watch(expanded, (isExpanded) => {
	// The toast must not disappear out from under a user reading the full text;
	// collapsing hands back a fresh full auto-hide delay, not the leftovers.
	if (isExpanded) hold();
	else release();
	// Expanding changes the clamp, so the fit verdict has to be taken again.
	void measure();
});
</script>

<template>
	<!--
		Bottom-right anchor: the toast sits out of the way of the main content
		column, and the max width keeps a long message from spanning the window.
	-->
	<div
		class="fixed right-4 bottom-4 z-99999 w-max max-w-[min(28rem,calc(100vw-2rem))]"
		role="status"
		aria-live="polite"
	>
		<Transition
			enter-active-class="transition-[opacity,transform] duration-200 ease-out"
			enter-from-class="translate-y-1 opacity-0"
			leave-active-class="transition-[opacity,transform] duration-150 ease-in"
			leave-to-class="translate-y-1 opacity-0"
		>
			<div
				v-if="visible"
				class="flex items-start gap-2 rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg"
			>
				<div class="flex min-w-0 flex-1 flex-col gap-1.5">
					<span
						ref="messageEl"
						class="break-words"
						:class="expanded ? 'max-h-[60vh] overflow-y-auto whitespace-pre-wrap' : 'line-clamp-2 whitespace-pre-wrap'"
					>
						{{ message }}
					</span>
					<button
						v-if="action"
						type="button"
						class="self-start rounded-md bg-primary px-2 py-0.5 font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-primary/50 focus-visible:ring-2 focus-visible:outline-none"
						@click="runAction"
					>
						{{ action.label }}
					</button>
				</div>
				<!--
					Only rendered when the clamp actually hides text: a one-line toast
					growing a chevron would be a control that does nothing.
				-->
				<button
					v-if="overflows"
					type="button"
					class="hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors"
					:aria-label="expanded ? 'Collapse notification' : 'Expand notification'"
					:aria-expanded="expanded"
					@click="expanded = !expanded"
				>
					<!-- Collapsed shows "Up" because that is what pressing it will do. -->
					<ChevronUp v-if="!expanded" class="size-3.5" aria-hidden="true" />
					<ChevronDown v-else class="size-3.5" aria-hidden="true" />
				</button>
				<!-- Auto-hide is the primary exit; this is only for hover/keyboard users. -->
				<button
					type="button"
					class="hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors"
					aria-label="Dismiss notification"
					@click="dismiss"
				>
					<X class="size-3.5" aria-hidden="true" />
				</button>
			</div>
		</Transition>
	</div>
</template>