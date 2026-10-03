<script setup lang="ts">
/**
 * The connection profile form: the fields shared by both drivers, the
 * per-driver TLS block, and the Advanced section.
 *
 * The component is fully controlled — it never mutates `modelValue`, it emits
 * a new `ConnectionConfig` on every edit.
 */
import type { AcceptableValue } from "reka-ui";
import { computed, ref, useId, watch } from "vue";
import type { ConnectionConfig } from "@shared/types";
import {
	MYSQL_TLS_MODE_LABELS,
	MYSQL_TLS_MODES,
	MYSQL_URL_PARAMS_PLACEHOLDER,
	POSTGRES_TLS_MODE_LABELS,
	POSTGRES_TLS_MODES,
	POSTGRES_URL_PARAMS_PLACEHOLDER,
	TLS_FILE_KEYS,
	readUrlParam,
	setUrlParam,
	tlsModeOf,
	withTlsMode,
	type ConnectionFieldErrors,
	type MysqlTlsMode,
	type PostgresTlsMode,
} from "../../lib/connectionDefaults";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";

const props = withDefaults(defineProps<{
	modelValue: ConnectionConfig;
	/** Inline validation messages, keyed by field name. */
	errors?: ConnectionFieldErrors;
	/**
	 * Databases the server reported on the last successful test. The Database
	 * field renders as a picker over these once they are known, and stays a
	 * free-text input otherwise — a profile can legitimately point at a
	 * database the listing was not allowed to see.
	 */
	databases?: string[];
	/** Schemas for PostgreSQL, same caveat. */
	schemas?: string[];
}>(), { databases: () => [], schemas: () => [] });

const emit = defineEmits<{
	(e: "update:modelValue", value: ConnectionConfig): void;
}>();

type TextField =
	| "name"
	| "host"
	| "username"
	| "password"
	| "database"
	| "defaultSchema"
	| "urlParams"
	| "note";
type NumberField = "port" | "connectTimeoutSecs" | "queryTimeoutSecs";

const uid = useId();

function setText(field: TextField, value: string | number) {
	emit("update:modelValue", { ...props.modelValue, [field]: String(value) });
}

function setNumber(field: NumberField, value: string | number) {
	const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
	emit("update:modelValue", {
		...props.modelValue,
		[field]: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
	});
}

// Number inputs are held as text so a half-typed value ("", "3") does not get
// rewritten to 0 under the caret; the parsed number is mirrored into the config.
const portText = ref(String(props.modelValue.port));
const connectTimeoutText = ref(String(props.modelValue.connectTimeoutSecs));
const queryTimeoutText = ref(String(props.modelValue.queryTimeoutSecs));
// Text is pulled back from the config only when it disagrees with what is on
// screen, so clearing a field (stored as 0) does not rewrite "0" under the
// caret while the user is still typing.
watch(
	() => props.modelValue.port,
	(value) => {
		if (Number(portText.value) !== value) portText.value = String(value);
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
watch(
	() => props.modelValue.queryTimeoutSecs,
	(value) => {
		if (Number(queryTimeoutText.value) !== value) {
			queryTimeoutText.value = String(value);
		}
	},
);

const isPostgres = computed(() => props.modelValue.dbType === "postgres");
const fileKeys = computed(() => TLS_FILE_KEYS[props.modelValue.dbType]);

/** The TLS mode's human name, so a collapsed TLS section still says what it is
 *  set to. */
const tlsModeLabel = computed(() => {
	const mode = tlsModeOf(props.modelValue);
	return isPostgres.value
		? POSTGRES_TLS_MODE_LABELS[mode as PostgresTlsMode]
		: MYSQL_TLS_MODE_LABELS[mode as MysqlTlsMode];
});

function onTlsMode(value: AcceptableValue) {
	if (typeof value !== "string") return;
	emit(
		"update:modelValue",
		withTlsMode(props.modelValue, value as PostgresTlsMode | MysqlTlsMode),
	);
}

function onTlsFile(field: "ca" | "cert" | "key", value: string | number) {
	const key = TLS_FILE_KEYS[props.modelValue.dbType][field];
	emit("update:modelValue", {
		...props.modelValue,
		urlParams: setUrlParam(props.modelValue.urlParams, [key], String(value)),
	});
}

/**
 * Postgres opens every transaction read-only. It travels as a libpq runtime
 * parameter, which the driver forwards verbatim, so it lives in `urlParams`
 * like any other driver setting.
 */
const READ_ONLY_PARAM = "default_transaction_read_only";
const readOnly = computed({
	get: () => readUrlParam(props.modelValue.urlParams, READ_ONLY_PARAM) === "on",
	set: (checked: boolean) => {
		emit("update:modelValue", {
			...props.modelValue,
			urlParams: setUrlParam(
				props.modelValue.urlParams,
				[READ_ONLY_PARAM],
				checked ? "on" : null,
			),
		});
	},
});

const savePassword = computed({
	get: () => props.modelValue.savePassword,
	set: (checked: boolean) => {
		emit("update:modelValue", { ...props.modelValue, savePassword: checked });
	},
});

/** Postgres only — MySQL has no schema level to reveal. */
const showSystemSchemas = computed({
	get: () => props.modelValue.showSystemSchemas,
	set: (checked: boolean) => {
		emit("update:modelValue", {
			...props.modelValue,
			showSystemSchemas: checked,
		});
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
        placeholder="Local Postgres"
        :aria-invalid="Boolean(errors?.name)"
        :aria-describedby="errors?.name ? `${uid}-name-error` : undefined"
        @update:model-value="setText('name', $event)"
      />
      <p
        v-if="errors?.name"
        :id="`${uid}-name-error`"
        class="mt-1 text-xs text-destructive"
      >
        {{ errors.name }}
      </p>
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
      <p
        v-if="errors?.host"
        :id="`${uid}-host-error`"
        class="mt-1 text-xs text-destructive"
      >
        {{ errors.host }}
      </p>
    </div>

    <div>
      <Label :for="`${uid}-port`" class="mb-1 block">Port</Label>
      <Input
        :id="`${uid}-port`"
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        type="number"
        min="1"
        max="65535"
        :model-value="portText"
        :aria-invalid="Boolean(errors?.port)"
        :aria-describedby="errors?.port ? `${uid}-port-error` : undefined"
        @update:model-value="setNumber('port', $event)"
      />
      <p
        v-if="errors?.port"
        :id="`${uid}-port-error`"
        class="mt-1 text-xs text-destructive"
      >
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
        :aria-invalid="Boolean(errors?.username)"
        :aria-describedby="errors?.username ? `${uid}-username-error` : undefined"
        @update:model-value="setText('username', $event)"
      />
      <p
        v-if="errors?.username"
        :id="`${uid}-username-error`"
        class="mt-1 text-xs text-destructive"
      >
        {{ errors.username }}
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
      <p class="mt-1 text-xs text-muted-foreground">
        Stored in memory only; see “Save password” below.
      </p>
    </div>

    <div :class="isPostgres ? '' : 'col-span-2'">
      <Label :for="`${uid}-database`" class="mb-1 block">Database</Label>
      <Input
        :id="`${uid}-database`"
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        :model-value="modelValue.database"
        :list="databases.length ? `${uid}-databases` : undefined"
        :placeholder="isPostgres ? 'postgres' : 'mysql'"
        @update:model-value="setText('database', $event)"
      />
      <!-- A datalist keeps the field freely editable while still offering the
           server's own names; a locked-down select would refuse values the
           listing could not see. -->
      <datalist
        v-if="databases.length"
        :id="`${uid}-databases`"
      >
        <option v-for="name in databases" :key="name" :value="name" />
      </datalist>
      <p
        v-if="databases.length"
        :id="`${uid}-database-hint`"
        class="mt-1 text-xs text-muted-foreground"
      >
        {{ databases.length }} databases found — press “Test connection” to refresh
      </p>
    </div>

    <div v-if="isPostgres">
      <Label :for="`${uid}-schema`" class="mb-1 block">Default schema</Label>
      <Input
        :id="`${uid}-schema`"
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        :model-value="modelValue.defaultSchema"
        :list="schemas.length ? `${uid}-schemas` : undefined"
        placeholder="public"
        @update:model-value="setText('defaultSchema', $event)"
      />
      <datalist v-if="schemas.length" :id="`${uid}-schemas`">
        <option v-for="name in schemas" :key="name" :value="name" />
      </datalist>
    </div>

    <div class="col-span-2">
      <Label :for="`${uid}-url-params`" class="mb-1 block">URL parameters</Label>
      <Input
        :id="`${uid}-url-params`"
        spellcheck="false"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        :model-value="modelValue.urlParams"
        :placeholder="isPostgres ? POSTGRES_URL_PARAMS_PLACEHOLDER : MYSQL_URL_PARAMS_PLACEHOLDER"
        :aria-describedby="`${uid}-url-params-hint`"
        @update:model-value="setText('urlParams', $event)"
      />
      <p :id="`${uid}-url-params-hint`" class="mt-1 text-xs text-muted-foreground">
        Appended verbatim to the driver URL, e.g.
        <code class="font-mono">{{ isPostgres ? 'application_name=recall' : 'charset=utf8mb4' }}</code>
      </p>
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

    <div :class="isPostgres ? '' : 'col-span-2'">
      <div class="flex items-center gap-2">
        <Switch
          :id="`${uid}-save-password`"
          :model-value="savePassword"
          @update:model-value="savePassword = $event"
        />
        <Label :for="`${uid}-save-password`">
          Save password
        </Label>
      </div>
      <p class="mt-1 text-xs text-muted-foreground">
        On: stored in the system keychain so it survives a restart.
        Off: kept in memory only, and forgotten when the app quits.
      </p>
    </div>

    <div v-if="isPostgres">
      <div class="flex items-center gap-2">
        <Switch
          :id="`${uid}-show-system-schemas`"
          :model-value="showSystemSchemas"
          @update:model-value="showSystemSchemas = $event"
        />
        <Label :for="`${uid}-show-system-schemas`">
          Show system schemas
        </Label>
      </div>
      <p class="mt-1 text-xs text-muted-foreground">
        Include <code class="font-mono">pg_*</code> and
        <code class="font-mono">information_schema</code>.
      </p>
    </div>
  </div>

  <details class="mt-4 rounded-md border border-border">
    <summary class="flex h-7 cursor-pointer list-none items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
      TLS — {{ tlsModeLabel }}
    </summary>
    <div class="grid grid-cols-2 gap-x-3 gap-y-2.5 border-t border-border p-3">
      <div class="col-span-2">
        <Label :for="`${uid}-tls-mode`" class="mb-1 block">Mode</Label>
        <Select
          :model-value="tlsModeOf(modelValue)"
          @update:model-value="onTlsMode"
        >
          <SelectTrigger :id="`${uid}-tls-mode`" class="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <template v-if="isPostgres">
              <SelectItem
                v-for="mode in POSTGRES_TLS_MODES"
                :key="mode"
                :value="mode"
              >
                {{ POSTGRES_TLS_MODE_LABELS[mode] }}
              </SelectItem>
            </template>
            <template v-else>
              <SelectItem
                v-for="mode in MYSQL_TLS_MODES"
                :key="mode"
                :value="mode"
              >
                {{ MYSQL_TLS_MODE_LABELS[mode] }}
              </SelectItem>
            </template>
          </SelectContent>
        </Select>
      </div>

      <div class="col-span-2">
        <Label :for="`${uid}-tls-ca`" class="mb-1 block">Server CA file</Label>
        <Input
          :id="`${uid}-tls-ca`"
          :model-value="readUrlParam(modelValue.urlParams, fileKeys.ca)"
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          placeholder="/path/to/ca.pem"
          @update:model-value="onTlsFile('ca', $event)"
        />
      </div>

      <div>
        <Label :for="`${uid}-tls-cert`" class="mb-1 block">Client certificate</Label>
        <Input
          :id="`${uid}-tls-cert`"
          :model-value="readUrlParam(modelValue.urlParams, fileKeys.cert)"
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          placeholder="/path/to/client.pem"
          @update:model-value="onTlsFile('cert', $event)"
        />
      </div>

      <div>
        <Label :for="`${uid}-tls-key`" class="mb-1 block">Client key</Label>
        <Input
          :id="`${uid}-tls-key`"
          :model-value="readUrlParam(modelValue.urlParams, fileKeys.key)"
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          placeholder="/path/to/client.key"
          @update:model-value="onTlsFile('key', $event)"
        />
      </div>
    </div>
  </details>

  <details class="mt-4 rounded-md border border-border">
    <summary class="flex h-7 cursor-pointer list-none items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
      Advanced
    </summary>
    <div class="grid grid-cols-2 gap-x-3 gap-y-2.5 border-t border-border p-3">
      <div>
        <Label :for="`${uid}-connect-timeout`" class="mb-1 block">
          Connect timeout (seconds)
        </Label>
        <Input
          :id="`${uid}-connect-timeout`"
          type="number"
          min="0"
          :model-value="connectTimeoutText"
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          @update:model-value="setNumber('connectTimeoutSecs', $event)"
        />
      </div>

      <div>
        <Label :for="`${uid}-query-timeout`" class="mb-1 block">
          Query timeout (seconds)
        </Label>
        <Input
          :id="`${uid}-query-timeout`"
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          type="number"
          min="0"
          :model-value="queryTimeoutText"
          :aria-describedby="`${uid}-query-timeout-hint`"
          @update:model-value="setNumber('queryTimeoutSecs', $event)"
        />
        <p :id="`${uid}-query-timeout-hint`" class="mt-1 text-xs text-muted-foreground">
          0 means no limit.
        </p>
      </div>

      <div v-if="isPostgres" class="col-span-2">
        <div class="flex items-center gap-2">
          <Switch
            :id="`${uid}-read-only`"
            :model-value="readOnly"
            @update:model-value="readOnly = $event"
          />
          <Label :for="`${uid}-read-only`">
            Read-only session
          </Label>
        </div>
        <p class="mt-1 text-xs text-muted-foreground">
          Every transaction is opened read-only.
        </p>
      </div>
    </div>
  </details>
</template>