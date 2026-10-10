import { ref, type Ref } from "vue";

/** The grid's face: the app's own mono, or the reference app's sans. */
export type GridFont = "default" | "dbx";

const STORAGE_KEY = "recall.gridFont";

/**
 * `tokens.css` scopes the DBX stack behind this attribute on the root element.
 * `default` is the token's own value, so it needs no marker.
 */
function applyGridFont(font: GridFont) {
	if (font === "dbx") {
		document.documentElement.dataset.gridFont = "dbx";
	} else {
		delete document.documentElement.dataset.gridFont;
	}
}

function preferredGridFont(): GridFont {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "default" || stored === "dbx") return stored;
	} catch {
		// Storage unavailable: fall through to the default.
	}
	return "default";
}

// Module-level, like `useTheme`: one window, one grid face, applied on load so
// the first paint is already correct.
const font = ref<GridFont>(preferredGridFont());
applyGridFont(font.value);

export interface UseGridFont {
	font: Ref<GridFont>;
	set(next: GridFont): void;
}

/** Reads and switches the grid typeface, persisting the choice. */
export function useGridFont(): UseGridFont {
	function set(next: GridFont) {
		font.value = next;
		applyGridFont(next);
		try {
			localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// Storage unavailable: the font still applies for this session.
		}
	}

	return { font, set };
}
