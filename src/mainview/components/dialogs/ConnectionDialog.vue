<script setup lang="ts">
/**
 * Create / edit a connection profile.
 *
 * The dialog owns a draft `ConnectionConfig`; edits flow one way into the
 * draft, and only "Save & Connect" writes to the store. Testing runs against
 * the draft, so a profile can be verified before it is ever saved.
 */
import { CheckIcon, CopyIcon, Loader2Icon, PlugIcon } from "lucide-vue-next";
import type { AcceptableValue } from "reka-ui";
import { computed, ref, watch } from "vue";
import type {
	ConnectionConfig,
	ConnectionTestResult,
	DatabaseType,
} from "@shared/types";
import {
	DB_TYPE_LABELS,
	DEFAULT_PORTS,
	DEFAULT_USERS,
	emptyConnection,
	type ConnectionFieldErrors,
} from "../../lib/connectionDefaults";
import { errorMessage } from "../../lib/rpc";
import { toast } from "../../composables/useToast";
import { useConnectionsStore } from "../../stores/connections";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogScrollContent,
	DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import ConnectionFormFields from "./ConnectionFormFields.vue";

const props = defineProps<{
	open: boolean;
	/** Id of the profile being edited; `null` starts a blank draft. */
	editId?: string | null;
}>();

const emit = defineEmits<{
	(e: "update:open", value: boolean): void;
}>();

const connections = useConnectionsStore();

const draft = ref<ConnectionConfig>(emptyConnection("postgres"));
const errors = ref<ConnectionFieldErrors>({});
const testResult = ref<ConnectionTestResult | null>(null);
/** Filled by a successful test; drives the database and schema pickers. */
const availableDatabases = ref<string[]>([]);
const availableSchemas = ref<string[]>([]);
const failure = ref("");
const busy = ref<"test" | "connect" | null>(null);
const copied = ref(false);

const title = computed(() =>
	props.editId ? "Edit connection" : "New connection",
);

watch(
	() => props.open,
	(open) => {
		if (!open) return;
		errors.value = {};
		testResult.value = null;
		failure.value = "";
		copied.value = false;
		busy.value = null;
		const existing = props.editId
			? connections.configs.find((entry) => entry.id === props.editId)
			: undefined;
		draft.value = existing
			? {
					...existing,
					// Persisted profiles carry no password. Only a profile that
					// saves its password may be prefilled from the session cache;
					// otherwise the field starts blank and whatever the user
					// types this session is what gets used.
					password: existing.savePassword
						? (connections.passwords[existing.id] ?? "")
						: "",
				}
			: emptyConnection("postgres");
	},
	{ immediate: true },
);

function onDbType(value: AcceptableValue) {
	if (value !== "postgres" && value !== "mysql") return;
	const dbType: DatabaseType = value;
	if (dbType === draft.value.dbType) return;
	draft.value = {
		...draft.value,
		dbType,
		port: DEFAULT_PORTS[dbType],
		username: DEFAULT_USERS[dbType],
		defaultSchema: dbType === "postgres" ? "public" : "",
		ssl: false,
		urlParams: "",
	};
	testResult.value = null;
	failure.value = "";
}

function onDraft(value: ConnectionConfig) {
	draft.value = value;
	testResult.value = null;
	failure.value = "";
	errors.value = {};
}

/**
 * `requireName` is now unused: a name is optional everywhere, and an empty one
 * falls back to the host so the connection is still identifiable in the tree.
 */
function validate(): boolean {
	const next: ConnectionFieldErrors = {};
	if (!draft.value.host.trim()) {
		next.host = "Enter a host.";
	} else if (!Number.isInteger(draft.value.port) || draft.value.port <= 0) {
		next.port = "Enter a port between 1 and 65535.";
	} else if (draft.value.port > 65535) {
		next.port = "Port must be 65535 or lower.";
	}
	if (!draft.value.username.trim()) next.username = "Enter a user.";
	errors.value = next;
	return Object.keys(next).length === 0;
}

// `testConnection` reports failure in its result rather than rejecting, so a
// failed handshake is surfaced through the same panel as a failed connect.
async function runTest() {
	if (busy.value || !validate()) return;
	busy.value = "test";
	testResult.value = null;
	failure.value = "";
	try {
		const result = await connections.test({ ...draft.value });
		if (result.ok) {
			testResult.value = result;
			// A working handshake is the only moment the server will report what
			// exists, so that is when the pickers get their options.
			availableDatabases.value = result.databases ?? [];
			availableSchemas.value = result.schemas ?? [];
		} else failure.value = result.message;
	} catch (err) {
		failure.value = errorMessage(err);
	} finally {
		busy.value = null;
	}
}

async function saveAndConnect() {
	if (busy.value || !validate()) return;
	busy.value = "connect";
	testResult.value = null;
	failure.value = "";
	const id = draft.value.id;
	// Captured before the save: a profile with `savePassword: false` has its
	// session cache entry dropped on persist, so the typed password has to be
	// handed to `connect` explicitly or the handshake goes out without it.
	const password = draft.value.password;
	// The name is optional; the host is what identifies the connection anyway,
	// so an empty label becomes the host rather than a blank row in the tree.
	const name = draft.value.name.trim() || draft.value.host.trim();
	try {
		if (props.editId) connections.update(id, { ...draft.value, name });
		else connections.add({ ...draft.value, name });
		await connections.connect(id, password);
		emit("update:open", false);
	} catch (err) {
		failure.value = errorMessage(err);
		busy.value = null;
	}
}

async function copyFailure() {
	try {
		await navigator.clipboard.writeText(failure.value);
		copied.value = true;
		toast("Error copied to clipboard");
	} catch {
		toast("Could not copy the error");
	}
}
</script>

<template>
  <Dialog
    :open="open"
    @update:open="emit('update:open', $event)"
  >
    <DialogScrollContent class="sm:max-w-[560px]">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>
          PostgreSQL and MySQL profiles. Passwords stay in memory for this
          session.
        </DialogDescription>
      </DialogHeader>

      <div>
        <Label for="conn-db-type" class="mb-1 block">Database type</Label>
        <Select
          :model-value="draft.dbType"
          @update:model-value="onDbType"
        >
          <SelectTrigger id="conn-db-type" class="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="postgres">
              {{ DB_TYPE_LABELS.postgres }}
            </SelectItem>
            <SelectItem value="mysql">
              {{ DB_TYPE_LABELS.mysql }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <ConnectionFormFields
        :model-value="draft"
        :errors="errors"
        :databases="availableDatabases"
        :schemas="availableSchemas"
        @update:model-value="onDraft"
      />

      <div
        v-if="testResult?.ok && testResult.databaseInfo"
        class="rounded-md border border-border bg-success-bg px-3 py-2 text-sm"
      >
        <p class="flex items-center gap-1.5 text-success">
          <CheckIcon class="size-4" aria-hidden="true" />
          Connected to
          {{ testResult.databaseInfo.productName }}
          {{ testResult.databaseInfo.productVersion }}
        </p>
        <p class="mt-0.5 text-xs text-muted-foreground">
          Database:
          {{ testResult.databaseInfo.currentDatabase ?? "unknown" }}
        </p>
      </div>


      <div
        v-if="failure"
        class="space-y-1.5 rounded-md border border-destructive/40 px-3 py-2"
      >
        <p class="text-xs text-muted-foreground">
          Connection failed — full error message
        </p>
        <pre class="recall-scroll max-h-40 select-text overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-background p-2 font-mono text-xs leading-5 text-destructive">{{ failure }}</pre>
        <div class="flex justify-end">
          <Button
            variant="outline"
            size="xs"
            :aria-label="copied ? 'Error copied to clipboard' : 'Copy error message'"
            @click="copyFailure"
          >
            <CheckIcon v-if="copied" aria-hidden="true" />
            <CopyIcon v-else aria-hidden="true" />
            {{ copied ? "Copied" : "Copy" }}
          </Button>
        </div>
      </div>

      <DialogFooter class="-mx-6 -mb-6 mt-2 rounded-b-md border-t border-border p-3 sm:rounded-b-md">
        <Button
          variant="outline"
          :disabled="busy !== null"
          @click="runTest"
        >
          <Loader2Icon
            v-if="busy === 'test'"
            class="animate-spin"
            aria-hidden="true"
          />
          <PlugIcon v-else aria-hidden="true" />
          Test connection
        </Button>
        <Button
          variant="ghost"
          :disabled="busy !== null"
          @click="emit('update:open', false)"
        >
          Cancel
        </Button>
        <Button
          :disabled="busy !== null"
          @click="saveAndConnect"
        >
          <Loader2Icon
            v-if="busy === 'connect'"
            class="animate-spin"
            aria-hidden="true"
          />
          Save &amp; connect
        </Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>