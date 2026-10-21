<script setup lang="ts">
/**
 * A `redis-cli`-style console on the tab's db. The backend decides what is
 * safe: a command outside its read-only allowlist comes back unrun, and only a
 * second, explicit "Run anyway" sends it. History lives for the tab's session.
 */
import { CornerDownLeft } from "lucide-vue-next";
import { nextTick, ref } from "vue";
import { formatReply } from "../../lib/redisFormat";
import { errorMessage, RPC_TIMEOUTS, rpc } from "../../lib/rpc";
import { Button } from "../ui/button";

const props = defineProps<{ connectionId: string; db: number }>();

const emit = defineEmits<{
	/** A command that may have changed data ran, so open views are stale. */
	(e: "wrote"): void;
}>();

interface Entry {
	id: number;
	command: string;
	state: "running" | "ok" | "error" | "confirm";
	output: string;
	timeMs?: number;
}

const entries = ref<Entry[]>([]);
const input = ref("");
const history: string[] = [];
let historyAt = 0;
let nextId = 0;
const output = ref<HTMLElement | null>(null);

async function scrollToEnd(): Promise<void> {
	await nextTick();
	output.value?.scrollTo({ top: output.value.scrollHeight });
}

async function run(entry: Entry, confirmed: boolean): Promise<void> {
	entry.state = "running";
	try {
		const result = await rpc.request.redisExecute(
			{ connectionId: props.connectionId, db: props.db, command: entry.command, confirmed },
			{ maxRequestTime: RPC_TIMEOUTS.metadata },
		);
		if (result.status === "needsConfirmation") {
			entry.state = "confirm";
			entry.output = "This command is not known to be read-only and may change data.";
		} else if (result.status === "error") {
			entry.state = "error";
			entry.output = `(error) ${result.message}`;
			entry.timeMs = result.timeMs;
		} else {
			entry.state = "ok";
			entry.output = formatReply(result.reply);
			entry.timeMs = result.timeMs;
			if (confirmed) emit("wrote");
		}
	} catch (err) {
		entry.state = "error";
		entry.output = errorMessage(err);
	}
	await scrollToEnd();
}

function submit(): void {
	const command = input.value.trim();
	if (!command) return;
	if (history[history.length - 1] !== command) history.push(command);
	historyAt = history.length;
	input.value = "";
	const entry: Entry = { id: nextId++, command, state: "running", output: "" };
	entries.value.push(entry);
	// The reactive copy, so the state changes in `run` reach the template.
	void run(entries.value[entries.value.length - 1], false);
}

function recall(step: -1 | 1): void {
	if (history.length === 0) return;
	historyAt = Math.min(history.length, Math.max(0, historyAt + step));
	input.value = history[historyAt] ?? "";
}
</script>

<template>
	<div class="flex h-full min-h-0 flex-col font-mono text-xs">
		<div ref="output" class="recall-scroll min-h-0 flex-1 overflow-auto p-2">
			<p v-if="entries.length === 0" class="text-muted-foreground">
				Run Redis commands against db{{ db }}, e.g. <span class="text-foreground">INFO memory</span>. ↑/↓ for history.
			</p>
			<div v-for="entry in entries" :key="entry.id" class="mb-2">
				<div class="flex items-center gap-2">
					<span class="text-muted-foreground">db{{ db }}&gt;</span>
					<span class="min-w-0 flex-1 break-all">{{ entry.command }}</span>
					<span v-if="entry.timeMs !== undefined" class="shrink-0 text-muted-foreground tabular-nums">{{ entry.timeMs }} ms</span>
				</div>
				<pre
					v-if="entry.output"
					class="select-text whitespace-pre-wrap break-all"
					:class="{ 'text-destructive': entry.state === 'error', 'text-amber-600 dark:text-amber-400': entry.state === 'confirm' }"
				>{{ entry.output }}</pre>
				<div v-if="entry.state === 'confirm'" class="mt-1 flex gap-1">
					<Button variant="destructive" size="xs" @click="run(entry, true)">Run anyway</Button>
					<Button variant="ghost" size="xs" @click="entry.state = 'error'; entry.output = 'Cancelled.'">Cancel</Button>
				</div>
				<p v-else-if="entry.state === 'running'" class="text-muted-foreground">Running…</p>
			</div>
		</div>
		<form class="flex shrink-0 items-center gap-1 border-t border-border px-2 py-1" @submit.prevent="submit">
			<span class="text-muted-foreground">db{{ db }}&gt;</span>
			<input
				v-model="input"
				class="min-w-0 flex-1 bg-transparent py-1 outline-none"
				spellcheck="false"
				autocomplete="off"
				autocorrect="off"
				autocapitalize="off"
				aria-label="Redis command"
				placeholder="GET key"
				@keydown.up.prevent="recall(-1)"
				@keydown.down.prevent="recall(1)"
			/>
			<Button type="submit" variant="ghost" size="icon-xs" aria-label="Run command">
				<CornerDownLeft aria-hidden="true" />
			</Button>
		</form>
	</div>
</template>
