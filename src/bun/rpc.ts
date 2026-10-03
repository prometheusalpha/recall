import { BrowserView } from "electrobun/main";
import { openFileDialog, showItemInFolder } from "electrobun/main/utils";
import type { AppRPC } from "../shared/rpc";
import {
	handlers as coreHandlers,
	onConnectionLostEmitter,
	setProgressEmitter,
} from "./handlers";


/**
 * The request handlers live in `./handlers` precisely so that module carries no
 * Electrobun import: the native FFI library only exists inside the packaged
 * app, so a module that imports it cannot be loaded by a plain Bun process —
 * which would make every driver call reachable only from inside the GUI.
 *
 * This file is the thin shell around them. It binds the handlers to Electrobun's
 * typed RPC transport, wires the two one-way channels the handlers emit onto
 * that transport, and supplies the two handlers that genuinely need the native
 * library.
 */

/**
 * Where the picker should reopen. Module state rather than a parameter: the RPC
 * surface takes no arguments for `pickFolder`, and remembering the last folder
 * is the only state the call needs.
 */
let lastFolder: string | null = null;

/**
 * The two handlers that cannot live in `./handlers`.
 *
 * `openFileDialog` and `showItemInFolder` come from Electrobun's native FFI
 * library, which only exists inside the packaged app. Importing them into
 * `./handlers` would break the no-Electrobun-import invariant for the sake of
 * two functions.
 */
const nativeHandlers = {
	/** Native directory picker. Resolves null when the user cancels. */
	async pickFolder() {
		// The key is omitted rather than set to `undefined`: Electrobun merges
		// its options with an object spread, and a key that is present with an
		// undefined value overwrites the `"~/"` default. The default then never
		// reaches `toCString`, and the picker throws
		// "undefined is not an object (evaluating 'jsString.endsWith')".
		const picked = await openFileDialog({
			...(lastFolder ? { startingFolder: lastFolder } : {}),
			canChooseFiles: false,
			canChooseDirectory: true,
			allowsMultipleSelection: false,
			allowedFileTypes: "*",
		});
		if (picked.length > 0) lastFolder = picked[0];
		return picked[0] ?? null;
	},

	/** Show a file in Finder / Explorer. */
	revealInFolder({ path }: { path: string }) {
		showItemInFolder(path);
	},
};

/** The full `BunRequests` surface: testable core plus the native handlers. */
export const handlers = { ...coreHandlers, ...nativeHandlers };

export const rpc = BrowserView.defineRPC<AppRPC>({
	handlers: { requests: handlers },
});

setProgressEmitter((payload) => {
	rpc.send("queryProgress", payload);
});

onConnectionLostEmitter((connectionId, reason) => {
	rpc.send("connectionLost", { connectionId, reason });
});