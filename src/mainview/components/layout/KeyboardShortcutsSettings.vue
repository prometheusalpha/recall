<script setup lang="ts">
/**
 * Keyboard shortcut rebinding.
 *
 * Structured like `SnippetsSettings`: a scrollable dialog, rows grouped under
 * headings, one footer with the destructive-ish action on the left and Done on
 * the right.
 *
 * The one rule that is not obvious: while this dialog is open the dispatcher is
 * suspended. Recording a chord means pressing keys, and without `suspend` the
 * chord being recorded would also run the command it names — so `⌘⇧W` would
 * both rebind and close every other tab. The capture listener also swallows
 * `Tab` so focus cannot walk out of the chip mid-recording.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogScrollContent,
	DialogTitle,
} from "../ui/dialog";
import {
	formatBinding,
	SHORTCUT_COMMANDS,
	useShortcuts,
} from "../../composables/useShortcuts";
import type { CommandId } from "../../composables/useShortcuts";

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{
	(e: "update:open", value: boolean): void;
}>();

/** The command whose chip is recording, or null. */
const capturing = ref<CommandId | null>(null);
const { bindings, labelFor, bindingFor, suspend, setBinding, resetAll, normalizedKey } =
	useShortcuts();

/**
 * Rows grouped by command group while keeping `SHORTCUT_COMMANDS` order, so
 * the table reads top to bottom exactly as the table defines it.
 */
const groups = computed(() => {
	const ordered: { group: string; ids: CommandId[] }[] = [];
	for (const command of SHORTCUT_COMMANDS) {
		const existing = ordered.find((entry) => entry.group === command.group);
		if (existing) existing.ids.push(command.id);
		else ordered.push({ group: command.group, ids: [command.id] });
	}
	return ordered;
});

function isModified(id: CommandId): boolean {
	return bindings.value[id] !== undefined;
}

function chipLabel(id: CommandId): string {
	if (capturing.value === id) return "Press keys…";
	// `bindingFor` resolves the override to its default, so an untouched command
	// still shows the chord it actually responds to rather than a blank chip.
	const binding = bindingFor(id);
	if (!binding || binding.key === "") return "—";
	return formatBinding(binding);
}

function startCapture(id: CommandId): void {
	capturing.value = id;
}

function stopCapture(): void {
	capturing.value = null;
}

function onCaptureKeydown(event: KeyboardEvent): void {
	const id = capturing.value;
	if (id === null) return;
	// Nothing the recorder sees may reach the dispatcher or move focus.
	event.preventDefault();
	event.stopPropagation();
	if (event.key === "Escape") {
		stopCapture();
		return;
	}
	if (event.key === "Tab") return;
	const key = normalizedKey(event);
	// A bare modifier press names no chord; keep listening for the real one.
	if (key === null || ["Meta", "Control", "Shift", "Alt"].includes(key)) return;
	setBinding(id, {
		key,
		meta: event.metaKey,
		ctrl: event.ctrlKey,
		shift: event.shiftKey,
		alt: event.altKey,
	});
	stopCapture();
}

/**
 * `suspend` and the capture listener follow the dialog's *open* state, not its
 * mount: the parent renders this component unconditionally and drives it with
 * `v-model:open`, so a mount-time hook would suspend the dispatcher for the
 * whole app lifetime and no shortcut would ever fire again.
 */
watch(
	() => props.open,
	(open) => {
		suspend.value = open;
		if (open) {
			// Reopening must not resume a capture the user walked away from.
			stopCapture();
			window.addEventListener("keydown", onCaptureKeydown, true);
		} else {
			window.removeEventListener("keydown", onCaptureKeydown, true);
		}
	},
	{ immediate: true },
);

onBeforeUnmount(() => {
	window.removeEventListener("keydown", onCaptureKeydown, true);
	// Module state outlives this component, so leaving it suspended would be a
	// leak the next session inherits.
	suspend.value = false;
});
</script>

<template>
	<Dialog :open="props.open" @update:open="emit('update:open', $event)">
		<DialogScrollContent class="sm:max-w-[640px]">
			<DialogHeader>
				<DialogTitle>Keyboard shortcuts</DialogTitle>
				<DialogDescription>
					Click a shortcut, then press the key combination you want. Escape
					cancels without changing anything. Shortcuts are recorded locally
					with the rest of this workspace's settings.
				</DialogDescription>
			</DialogHeader>

			<div class="recall-scroll max-h-[52vh] overflow-auto rounded-md border border-border">
				<div v-for="section in groups" :key="section.group" class="p-2">
					<h3 class="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						{{ section.group }}
					</h3>
					<ul>
						<li
							v-for="id in section.ids"
							:key="id"
							class="flex items-center justify-between gap-4 rounded-md px-2 py-2 hover:bg-accent/50"
						>
							<span class="flex items-center gap-2 text-sm">
								{{ labelFor(id) }}
								<span
									v-if="isModified(id)"
									class="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent-foreground"
								>
									modified
								</span>
							</span>
							<button
								type="button"
								class="rounded-md border border-border px-2 py-1 font-mono text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
								:class="[
									capturing === id
										? 'border-primary bg-primary/10 text-primary'
										: isModified(id)
											? 'text-foreground'
											: 'text-muted-foreground',
								]"
								:aria-label="`Record shortcut for ${labelFor(id)}`"
								@click="capturing === id ? stopCapture() : startCapture(id)"
							>
								{{ chipLabel(id) }}
							</button>
						</li>
					</ul>
				</div>
			</div>

			<DialogFooter class="sm:justify-between">
				<Button variant="outline" size="sm" @click="resetAll">
					Reset all
				</Button>
				<Button @click="emit('update:open', false)">Done</Button>
			</DialogFooter>
		</DialogScrollContent>
	</Dialog>
</template>
