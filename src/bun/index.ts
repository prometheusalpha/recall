import { BrowserWindow, Updater } from "electrobun/main";
import { rpc } from "./rpc";
import { closeAllConnections } from "./connectionPool";
import { setupApplicationMenu } from "./menu";

export { rpc } from "./rpc";
export { handlers } from "./rpc";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

// Check if Vite dev server is running for HMR
async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
			return DEV_SERVER_URL;
		} catch {
			console.log(
				"Vite dev server not running. Run 'hutch run dev:hmr' for HMR support.",
			);
		}
	}
	return "views://mainview/index.html";
}

// Declared before the window so the responder chain that makes ⌘X/⌘C/⌘V/⌘A
// reach the webview is in place by the time anything can take focus.
setupApplicationMenu();

// Create the main application window
const url = await getMainViewUrl();

const mainWindow = new BrowserWindow({
	title: "Recall",
	url,
	rpc,
	// Native frame. The custom chrome route needed a hand-tuned
	// `trafficLightOffset` to line the OS buttons up with a 40px toolbar, and
	// every window-manager difference on macOS moved them again. Letting the OS
	// draw its own titlebar is correct everywhere and costs one row of layout.
	titleBarStyle: "default",
	frame: {
		width: 1280,
		height: 820,
	},
});

mainWindow.on("close", () => {
	void closeAllConnections();
});

console.log("Recall started!");