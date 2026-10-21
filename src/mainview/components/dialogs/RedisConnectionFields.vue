<script setup lang="ts">
/**
 * The Redis profile form. A sibling of `ConnectionFormFields` rather than a
 * branch inside it: the SQL form is built around `urlParams`, schemas and TLS
 * modes, none of which Redis has, and each family's form grows on its own.
 *
 * Fully controlled, like the SQL form: every edit emits a new config.
 */
import { computed, ref, useId, watch } from "vue";
import type { RedisConnectionConfig } from "@shared/types";
import type { ConnectionFieldErrors } from "../../lib/connectionDefaults";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";

const props = defineProps<{
	modelValue: RedisConnectionConfig;
	errors?: ConnectionFieldErrors;
}>();

const emit = defineEmits<{
	(e: "update:modelValue", value: RedisConnectionConfig): void;
}>();

type TextField = "name" | "host" | "username" | "password" | "note";
type NumberField = "port" | "connectTimeoutSecs" | "defaultDb";

const uid = useId();

function setText(field: TextField, value: string | number) {
	emit("update:modelValue", { ...props.modelValue, [field]: String(value) });
}

/** An unparsable value is stored as 0, which validation then reports. */
function setNumber(field: NumberField, value: string | number) {
	const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
	emit("update:modelValue", {
		...props.modelValue,
		[field]: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
	});
}

// Held as text for the same reason as the SQL form: a half-typed number must
// not be rewritten under the caret.
const portText = ref(String(props.modelValue.port));
const defaultDbText = ref(String(props.modelValue.defaultDb));
const connectTimeoutText = ref(String(props.modelValue.connectTimeoutSecs));
watch(
	() => props.modelValue.port,
	(value) => {
		if (Number(portText.value) !== value) portText.value = String(value);
	},
);
watch(
	() => props.modelValue.defaultDb,
	(value) => {
		if (Number(defaultDbText.value) !== value) defaultDbText.value = String(value);
	},
);
watch(
	() => props.modelValue.connectTimeoutSecs,
	(value) => {
		if (Number(connectTimeoutText.value) !== value) {
			connectTimeoutText.value = String(value);
		}
	},
);

const ssl = computed({
	get: () => props.modelValue.ssl,
	set: (checked: boolean) => {
		emit("update:modelValue", { ...props.modelValue, ssl: checked });
	},
});

const savePassword = computed({
	get: () => props.modelValue.savePassword,
	set: (checked: boolean) => {
		emit("update:modelValue", { ...props.modelValue, savePassword: checked });
	},
});

function onNoteInput(event: Event) {
	setText("note", (event.target as HTMLTextAreaElement).value);
}
</script>

<template>
  <div class="grid grid-cols-2 gap-x-3 gap-y-2.5">
    <div class="col-span-2">
      <Label :for="`${uid}-name`" class="mb-1 block">Name</Label>
      <Input
        :id="`${uid}-name`"
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        :model-value="modelValue.name"
        placeholder="Local Redis"
        @update:model-value="setText('name', $event)"
      />
    </div>

    <div>
      <Label :for="`${uid}-host`" class="mb-1 block">Host</Label>
      <Input
        :id="`${uid}-host`"
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        :model-value="modelValue.host"
        placeholder="localhost"
        :aria-invalid="Boolean(errors?.host)"
        :aria-describedby="errors?.host ? `${uid}-host-error` : undefined"
        @update:model-value="setText('host', $event)"
      />
      <p v-if="errors?.host" :id="`${uid}-host-error`" class="mt-1 text-xs text-destructive">
        {{ errors.host }}
      </p>
    </div>

    <div>
      <Label :for="`${uid}-port`" class="mb-1 block">Port</Label>
      <Input
        :id="`${uid}-port`"
        type="number"
        min="1"
        max="65535"
        :model-value="portText"
        :aria-invalid="Boolean(errors?.port)"
        :aria-describedby="errors?.port ? `${uid}-port-error` : undefined"
        @update:model-value="setNumber('port', $event)"
      />
      <p v-if="errors?.port" :id="`${uid}-port-error`" class="mt-1 text-xs text-destructive">
        {{ errors.port }}
      </p>
    </div>

    <div>
      <Label :for="`${uid}-username`" class="mb-1 block">User</Label>
      <Input
        :id="`${uid}-username`"
        :model-value="modelValue.username"
        autocomplete="off"
        spellcheck="false"
        autocorrect="off"
        autocapitalize="off"
        placeholder="default"
        @update:model-value="setText('username', $event)"
      />
      <p class="mt-1 text-xs text-muted-foreground">
        Leave empty unless the server uses ACL users.
      </p>
    </div>

    <div>
      <Label :for="`${uid}-password`" class="mb-1 block">Password</Label>
      <Input
        :id="`${uid}-password`"
        type="password"
        :model-value="modelValue.password"
        autocomplete="new-password"
        spellcheck="false"
        autocorrect="off"
        autocapitalize="off"
        @update:model-value="setText('password', $event)"
      />
    </div>

    <div>
      <Label :for="`${uid}-default-db`" class="mb-1 block">Default database</Label>
      <Input
        :id="`${uid}-default-db`"
        type="number"
        min="0"
        :model-value="defaultDbText"
        @update:model-value="setNumber('defaultDb', $event)"
      />
    </div>

    <div>
      <Label :for="`${uid}-connect-timeout`" class="mb-1 block">
        Connect timeout (seconds)
      </Label>
      <Input
        :id="`${uid}-connect-timeout`"
        type="number"
        min="1"
        :model-value="connectTimeoutText"
        @update:model-value="setNumber('connectTimeoutSecs', $event)"
      />
    </div>

    <div class="col-span-2">
      <Label :for="`${uid}-note`" class="mb-1 block">Note</Label>
      <textarea
        :id="`${uid}-note`"
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        :value="modelValue.note"
        rows="2"
        placeholder="Anything worth remembering about this connection"
        class="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
        @input="onNoteInput"
      />
    </div>

    <div>
      <div class="flex items-center gap-2">
        <Switch
          :id="`${uid}-save-password`"
          :model-value="savePassword"
          @update:model-value="savePassword = $event"
        />
        <Label :for="`${uid}-save-password`">Save password</Label>
      </div>
      <p class="mt-1 text-xs text-muted-foreground">
        On: stored in the system keychain so it survives a restart.
      </p>
    </div>

    <div>
      <div class="flex items-center gap-2">
        <Switch :id="`${uid}-ssl`" :model-value="ssl" @update:model-value="ssl = $event" />
        <Label :for="`${uid}-ssl`">TLS</Label>
      </div>
      <p class="mt-1 text-xs text-muted-foreground">
        For servers that only accept encrypted connections.
      </p>
    </div>
  </div>
</template>
