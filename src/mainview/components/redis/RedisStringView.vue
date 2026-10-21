<script setup lang="ts">
/**
 * A string value as editable text. Read-only when what is on screen is not
 * the whole value — a prefix of a large string, or bytes that are not UTF-8 —
 * since saving either would overwrite the key with something else.
 */
import { Save } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import type { RedisBytes } from "../../../shared/redis";
import { Button } from "../ui/button";

const props = defineProps<{
	value: RedisBytes;
	byteLength: number;
	truncated: boolean;
	busy: boolean;
}>();

const emit = defineEmits<{ (e: "save", text: string): void }>();

const draft = ref(props.value.text);
watch(
	() => props.value,
	(value) => {
		draft.value = value.text;
	},
);

const readOnlyReason = computed(() => {
	if (props.truncated) return `Showing the first part of ${props.byteLength.toLocaleString()} bytes; too large to edit here.`;
	if (props.value.base64 !== undefined) return "Binary value, shown escaped; edit it from the console.";
	return null;
});

const dirty = computed(() => draft.value !== props.value.text);

/** Pretty-prints a JSON value in place; anything else is left as typed. */
const isJson = computed(() => {
	try {
		const parsed: unknown = JSON.parse(draft.value);
		return typeof parsed === "object" && parsed !== null;
	} catch {
		return false;
	}
});

function formatJson(): void {
	draft.value = JSON.stringify(JSON.parse(draft.value), null, 2);
}
</script>

<template>
	<div class="flex h-full min-h-0 flex-col">
		<p v-if="readOnlyReason" class="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
			{{ readOnlyReason }}
		</p>
		<textarea
			v-model="draft"
			class="recall-scroll min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-5 outline-none"
			spellcheck="false"
			autocomplete="off"
			autocorrect="off"
			autocapitalize="off"
			aria-label="String value"
			:readonly="readOnlyReason !== null"
			@keydown.meta.s.prevent="dirty && !readOnlyReason && emit('save', draft)"
		/>
		<div v-if="!readOnlyReason" class="flex h-9 shrink-0 items-center gap-1 border-t border-border px-2">
			<span class="text-xs text-muted-foreground tabular-nums">{{ byteLength.toLocaleString() }} bytes</span>
			<span class="flex-1" />
			<Button v-if="isJson" variant="ghost" size="xs" @click="formatJson">Format JSON</Button>
			<Button v-if="dirty" variant="ghost" size="xs" @click="draft = value.text">Revert</Button>
			<Button size="xs" :disabled="!dirty || busy" title="Save (⌘S); the TTL is kept" @click="emit('save', draft)">
				<Save aria-hidden="true" />
				Save
			</Button>
		</div>
	</div>
</template>
