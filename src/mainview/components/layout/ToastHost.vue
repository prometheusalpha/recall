<script setup lang="ts">
import { X } from "lucide-vue-next";
import { useToast } from "../../composables/useToast";

const { message, visible, action, dismiss } = useToast();

/** Runs the toast's single action, then clears the toast it belongs to. */
function runAction(): void {
	action.value?.run();
	dismiss();
}
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
				class="flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg"
			>
				<span class="min-w-0 flex-1 truncate">{{ message }}</span>
				<button
					v-if="action"
					type="button"
					class="shrink-0 rounded-md bg-primary px-2 py-0.5 font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-primary/50 focus-visible:ring-2 focus-visible:outline-none"
					@click="runAction"
				>
					{{ action.label }}
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
