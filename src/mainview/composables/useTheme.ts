import { ref, type Ref } from "vue";

export type Theme = "light" | "dark";

const STORAGE_KEY = "recall.theme";

/** `tokens.css` scopes its dark palette behind `.dark` on the root element. */
function applyTheme(theme: Theme) {
	document.documentElement.classList.toggle("dark", theme === "dark");
}

function preferredTheme(): Theme {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "light" || stored === "dark") return stored;
	} catch {
		// Storage unavailable: fall through to the OS preference.
	}
	if (
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-color-scheme: dark)").matches
	) {
		return "dark";
	}
	return "light";
}

// Module-level so every caller shares one ref; applied on load so the first
// paint is already correct (there is no flash of the wrong theme).
const theme = ref<Theme>(preferredTheme());
applyTheme(theme.value);

export interface UseTheme {
	theme: Ref<Theme>;
	toggle(): void;
	set(next: Theme): void;
}

/** Reads and flips the light/dark theme, persisting the choice. */
export function useTheme(): UseTheme {
	function set(next: Theme) {
		theme.value = next;
		applyTheme(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// Storage unavailable: the theme still applies for this session.
		}
	}

	return { theme, toggle: () => set(theme.value === "dark" ? "light" : "dark"), set };
}
