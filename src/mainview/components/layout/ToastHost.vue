<script setup lang="ts">
import { useToast } from "../../composables/useToast";

const { message, visible, action, dismiss } = useToast();

/** Runs the toast's single action, then clears the toast it belongs to. */
function runAction(): void {
	action.value?.run();
	dismiss();
}
</script>

<template>
	<div
		class="fixed bottom-6 inset-x-0 mx-auto z-99999 w-max max-w-[90vw]"
		role="status"
		aria-live="polite"
	>
		<Transition
			enter-active-class="transition-opacity duration-150"
			enter-from-class="opacity-0 translate-y-1"
			leave-active-class="transition-opacity duration-150"
			leave-to-class="opacity-0 translate-y-1"
		>
			<div
				v-if="visible"
				class="flex items-center gap-3 rounded-lg bg-foreground px-4 py-2 text-sm text-background shadow-lg"
			>
				<span class="truncate">{{ message }}</span>
				<button
					v-if="action"
					type="button"
					class="shrink-0 rounded-md bg-background/15 px-2 py-0.5 font-medium text-background hover:bg-background/25"
					@click="runAction"
				>
					{{ action.label }}
				</button>
			</div>
		</Transition>
	</div>
</template>
