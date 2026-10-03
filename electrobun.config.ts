import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "recall",
		identifier: "app.recall.desktop",
		version: "0.1.0",
		description: "A fast desktop SQL client — Electrobun + Vue",
	},
	build: {
		mainProcess: "cottontail",
		cottontail: {
			entrypoint: "src/bun/index.ts",
			// `SQL` (the PostgreSQL / MySQL / SQLite driver) is reached through a
			// dynamic `new SQL(...)` constructor, so the tree-shaking scan cannot
			// see it. Without this the packaged app boots and then throws
			// `Cottontail capability "sql" is unavailable` on first connect.
			capabilities: ["sql"],
		},
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
		},
		// Ignore Vite output in watch mode — HMR handles view rebuilds separately
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
			icons: "icon.iconset",
		},
		linux: {
			bundleCEF: false,
			icon: "assets/icon.png",
		},
		win: {
			bundleCEF: false,
			// Hutch converts the PNG source to a multi-size .ico at package time,
			// so one 256px image covers the taskbar and shortcut sizes.
			icon: "assets/icon.png",
		},
	},
} satisfies ElectrobunConfig;
