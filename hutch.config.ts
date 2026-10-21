// @hutch cli=0.27.1 cottontail=0.7.1
export default {
	scripts: {
		install: ["hutch", "install", "--frozen-lockfile"],
		start: "hutch scripts/fetch-rg.ts && hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun dev",
		dev: "hutch scripts/fetch-rg.ts && hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun dev --watch",
		"dev:hmr": ["hutch", "pm", "exec", "--", "concurrently", "hutch run hmr", "hutch run start"],
		hmr: "hutch electrobun prepare && hutch pm exec -- vite --port 5173",
		"redis:smoke": "hutch scripts/redis-smoke.ts",
		build: "hutch scripts/fetch-rg.ts && hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun build --env=stable",
		"build:canary": "hutch scripts/fetch-rg.ts && hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun build --env=canary",
	},
	electrobun: {
		version: "2.0.2",
	},
};
