/**
 * Renderer-side RPC singleton.
 *
 * `Electroview.defineRPC` builds the typed proxy for us; the raw proxy is the
 * whole public surface (`rpc.request.<method>(params)`), so stores call it
 * directly instead of hiding it behind per-method wrappers.
 *
 * `send` is the one-way `bun.messages` channel (renderer -> Bun).
 *
 * The `Electroview` instance is constructed here — that is what installs the
 * native transport on the RPC object — so every module shares one connection.
 */
import { Electroview } from "electrobun/view";
import type { AppRPC } from "../../shared/rpc";

export const rpc = Electroview.defineRPC<AppRPC>({
	handlers: {
		requests: { noop: () => {} },
	},
});

/** One-way messages to the Bun process (`bun.messages`). */
export const send = rpc.send;

new Electroview({ rpc });

/**
 * Request timeouts, in milliseconds. Electrobun defaults to 1s, which is far
 * too short for a driver handshake or an introspection query. Query execution
 * is bounded on the Bun side by the connection's `queryTimeoutSecs`, so the
 * renderer waits indefinitely for it.
 */
export const RPC_TIMEOUTS = {
	metadata: 30_000,
	execute: Infinity,
} as const;

/**
 * Extracts a human-readable message from a rejected RPC call. Electrobun
 * rejects with a plain `Error` carrying the Bun handler's message, but a
 * transport-level failure can surface anything, so no shape is assumed.
 */
export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string" && err.length > 0) return err;
	if (err && typeof err === "object" && "message" in err) {
		const { message } = err;
		if (typeof message === "string" && message.length > 0) return message;
	}
	return String(err);
}
