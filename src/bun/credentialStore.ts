/**
 * OS credential storage for database passwords.
 *
 * macOS is backed by the Keychain via the `security(1)` CLI that ships with the
 * OS, spawned with an argument vector — there is no shell in the path, so no
 * quoting or interpolation can leak the password into a command line, and the
 * value never appears in a log line or an error message.
 *
 * Every other platform is backed by an in-process `Map`. That store is
 * SESSION-ONLY: it is lost when the Bun process exits, so a saved password does
 * not survive a restart outside macOS. This is a deliberate limitation, not an
 * oversight — a plain `Map` is the only credential store reachable without a
 * new dependency, and it is honest about not being persistent.
 *
 * Every operation degrades to "nothing stored" instead of throwing: a missing
 * `security` binary, a locked keychain, or a non-zero exit must never stop the
 * app from connecting. A profile whose password cannot be persisted still
 * connects; it just has to be re-entered next launch.
 */

/** Namespace prefix, so entries are attributable to this app alone. */
const SERVICE_PREFIX = "recall.connection.";

export interface CredentialStore {
	save(connectionId: string, username: string, password: string): Promise<void>;
	load(connectionId: string, username: string): Promise<string | null>;
	remove(connectionId: string, username: string): Promise<void>;
}

/** Keychain service name for a connection profile. */
function serviceFor(connectionId: string): string {
	return `${SERVICE_PREFIX}${connectionId}`;
}

type RunResult = { code: number; stdout: string };

/**
 * Runs `security` with an argv vector and collects its output.
 *
 * Returns a non-zero `code` (or a synthetic one on spawn failure) instead of
 * throwing: the caller decides what a failure means. stderr is deliberately
 * discarded — `security` can echo prompt text, and a diagnostic is not worth a
 * chance of surfacing keychain contents.
 */
async function runSecurity(args: string[]): Promise<RunResult> {
	try {
		const proc = Bun.spawn(["security", ...args], {
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, LC_ALL: "C" },
		});
		const stdout = await new Response(proc.stdout).text();
		const code = await proc.exited;
		return { code, stdout };
	} catch {
		// `security` is not on PATH, or the process could not be spawned.
		return { code: -1, stdout: "" };
	}
}

const keychainStore: CredentialStore = {
	async save(connectionId, username, password) {
		if (!password) return;
		const { code } = await runSecurity([
			"add-generic-password",
			"-a",
			username,
			"-s",
			serviceFor(connectionId),
			"-w",
			password,
			"-U",
		]);
		if (code !== 0) {
			// Code only: the value itself, and any prompt echo, stay out of here.
			console.warn(
				`[recall] could not store the password for ${connectionId} (security exited ${code}); it will have to be re-entered next launch.`,
			);
		}
	},

	async load(connectionId, username) {
		const { code, stdout } = await runSecurity([
			"find-generic-password",
			"-a",
			username,
			"-s",
			serviceFor(connectionId),
			"-w",
		]);
		// 44 is `errSecItemNotFound`: the normal "no credential stored" answer.
		if (code !== 0) return null;
		// `security` terminates the secret with a newline; strip exactly that so
		// a password with meaningful leading or trailing spaces survives.
		return stdout.replace(/\r?\n$/, "");
	},

	async remove(connectionId, username) {
		// `security` exits 0 when there is nothing to delete, so no branch here.
		await runSecurity([
			"delete-generic-password",
			"-a",
			username,
			"-s",
			serviceFor(connectionId),
		]);
	},
};

/**
 * Session-only store for platforms without a credential backend. Passwords
 * live in this map until the process exits and nowhere else.
 */
function createMemoryStore(): CredentialStore {
	const entries = new Map<string, string>();
	const key = (connectionId: string, username: string) =>
		`${serviceFor(connectionId)}\u0000${username}`;
	return {
		async save(connectionId, username, password) {
			if (!password) return;
			entries.set(key(connectionId, username), password);
		},
		async load(connectionId, username) {
			return entries.get(key(connectionId, username)) ?? null;
		},
		async remove(connectionId, username) {
			entries.delete(key(connectionId, username));
		},
	};
}

/**
 * The credential store the app uses. On macOS this is the Keychain; on every
 * other platform it is session memory, and saved passwords do not survive a
 * restart.
 */
export const credentialStore: CredentialStore =
	process.platform === "darwin" ? keychainStore : createMemoryStore();
