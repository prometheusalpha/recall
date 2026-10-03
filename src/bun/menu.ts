/**
 * The macOS application menu.
 *
 * Copy / paste / select-all are not key events on macOS: AppKit turns ⌘X ⌘C ⌘V
 * ⌘A into `cut:` / `copy:` / `paste:` / `selectAll:` messages sent down the
 * responder chain, and only a menu item declares that mapping. Without a menu
 * the webview receives ⌘V as an ordinary keypress, and WebKit does not act on
 * it — so text pasted into an input never arrives, and ⌘A selects nothing.
 * Typing keeps working because those keys really are key events.
 *
 * Items are declared by `role`, which Electrobun turns into the matching
 * responder selector, so the window's first responder (the webview) performs
 * the edit itself. Accelerators are spelled out rather than inferred from the
 * item title, so the shortcuts are the macOS ones whatever the labels are.
 */
import { ApplicationMenu } from "electrobun/main";

export function setupApplicationMenu(): void {
	ApplicationMenu.setApplicationMenu([
		{
			label: "Recall",
			submenu: [
				{ role: "about" },
				{ type: "divider" },
				{ role: "hide", accelerator: "cmd+h" },
				{ role: "hideOthers", accelerator: "cmd+alt+h" },
				{ role: "showAll" },
				{ type: "divider" },
				{ role: "quit", accelerator: "cmd+q" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo", accelerator: "cmd+z" },
				{ role: "redo", accelerator: "cmd+shift+z" },
				{ type: "divider" },
				{ role: "cut", accelerator: "cmd+x" },
				{ role: "copy", accelerator: "cmd+c" },
				{ role: "paste", accelerator: "cmd+v" },
				{ role: "pasteAndMatchStyle", accelerator: "cmd+shift+v" },
				{ role: "delete" },
				{ type: "divider" },
				{ role: "selectAll", accelerator: "cmd+a" },
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize", accelerator: "cmd+m" },
				{ role: "zoom" },
				{ type: "divider" },
				{ role: "bringAllToFront" },
			],
		},
	]);
}
