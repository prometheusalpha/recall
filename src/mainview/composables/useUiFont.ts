import { ref, type Ref } from "vue";

/** The two faces the shell can wear: the host system's, or DBX's own stack. */
export type UiFont = "system" | "dbx";

const STORAGE_KEY = "recall.uiFont";

/**
 * `tokens.css` scopes the DBX stack behind this attribute on the root element.
 * `system` is the token's own value, so it needs no marker.
 */
function applyUiFont(font: UiFont) {
	if (font === "dbx") {
		document.documentElement.dataset.uiFont = "dbx";
	} else {
		delete document.documentElement.dataset.uiFont;
	}
}

function preferredUiFont(): UiFont {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "system" || stored === "dbx") return stored;
	} catch {
		// Storage unavailable: fall through to the default.
	}
	return "system";
}

// Module-level, like `useTheme`: one window, one face, applied on load so the
// first paint is already correct.
const font = ref<UiFont>(preferredUiFont());
applyUiFont(font.value);

export interface UseUiFont {
	font: Ref<UiFont>;
	set(next: UiFont): void;
}

/** Reads and switches the UI typeface, persisting the choice. */
export function useUiFont(): UseUiFont {
	function set(next: UiFont) {
		font.value = next;
		applyUiFont(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// Storage unavailable: the font still applies for this session.
		}
	}

	return { font, set };
}
