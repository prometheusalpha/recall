/**
 * Window-level keyboard shortcuts.
 *
 * The app had two hand-rolled `window` keydown listeners; this replaces them
 * with one command table so a binding is data, not a branch in a switch. Three
 * consumers have to agree — the settings dialog that records a chord, the
 * dispatcher that fires a command, and the command table that prints defaults —
 * so the registry is a module singleton (invariant 12: there is no provider to
 * read it from).
 *
 * Two decisions worth recording:
 *
 * - A binding always names the platform accel explicitly: `meta` on macOS,
 *   `ctrl` everywhere else. There is no synthetic "Mod" flag, because a
 *   modifier comparison that has to know about "Mod" is exactly the ambiguity
 *   this table exists to remove. Matching compares the four recorded booleans.
 * - The stored blob is user-writable (invariant 11), so every field is
 *   validated on the way in and a bad entry degrades to its default rather
 *   than throwing or half-applying.
 */
import { ref } from "vue";
import type { Ref } from "vue";

/** One chord: the key plus the four modifier flags, all compared exactly. */
export interface ShortcutBinding {
	key: string;
	meta: boolean;
	ctrl: boolean;
	shift: boolean;
	alt: boolean;
}

export type CommandId =
	| "tab.close"
	| "tab.closeOthers"
	| "tab.closeAll"
	| "tab.next"
	| "tab.prev"
	| "quickOpen.toggle"
	| "editor.formatSql"
	| "result.sortAsc"
	| "result.sortDesc"
	| "result.rerun"
	| "result.focusWhere";

export interface CommandDefinition {
	id: CommandId;
	label: string;
	group: string;
	defaultBinding: ShortcutBinding;
}

/**
 * Same platform test the bookmark-jump handler uses, so the two window
 * listeners agree on which physical key means "accel".
 */
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(
	navigator.platform || navigator.userAgent,
);

const STORAGE_KEY = "recall.shortcuts";

/**
 * Builds a default binding from the base key. The accel is filled in from the
 * platform rather than spelled per entry, so no entry can ever ship a `Mod`
 * flag or a missing modifier by accident.
 */
function accel(key: string, shift = false, alt = false): ShortcutBinding {
	return { key, meta: IS_MAC, ctrl: !IS_MAC, shift, alt };
}

export const SHORTCUT_COMMANDS: CommandDefinition[] = [
	{
		id: "tab.close",
		label: "Close tab",
		group: "Tabs",
		defaultBinding: accel("w"),
	},
	{
		id: "tab.closeOthers",
		label: "Close other tabs",
		group: "Tabs",
		defaultBinding: accel("w", true),
	},
	{
		id: "tab.closeAll",
		label: "Close all tabs",
		group: "Tabs",
		defaultBinding: accel("w", false, true),
	},
	{
		id: "tab.next",
		label: "Next tab",
		group: "Tabs",
		defaultBinding: accel("ArrowRight", false, true),
	},
	{
		id: "tab.prev",
		label: "Previous tab",
		group: "Tabs",
		defaultBinding: accel("ArrowLeft", false, true),
	},
	{
		id: "quickOpen.toggle",
		label: "Quick open",
		group: "View",
		defaultBinding: accel("p"),
	},
	/*
	 * Formatting needs the caret and the selection, so it is the editor that
	 * claims this one, from its own DOM handler, exactly like the grid chords
	 * below — with no implementation registered here.
	 *
	 * Option+Shift+F, spelled with real Alt on every platform rather than
	 * through `accel`: the chord is the same two modifiers everywhere, and
	 * neither of them is the Control that `Ctrl-Shift-<letter>` mnemonic
	 * assigning claims for its 36 slots — a default the app swallowed before
	 * the command could see it would be no default at all.
	 */
	{
		id: "editor.formatSql",
		label: "Format SQL",
		group: "Editor",
		defaultBinding: { key: "f", meta: false, ctrl: false, shift: true, alt: true },
	},
	/*
	 * Grid-owned chords: the two sorts (which spell out real Control on every
	 * platform, so `accel` would hand macOS ⌘⇧↑) plus the refresh.
	 *
	 * They stay on the table so they are rebindable and printable in the
	 * settings dialog, but deliberately *off* the window dispatcher's
	 * `runCommand` path that drives every other command here: a sort needs a
	 * focused cell and a refresh belongs to the grid that owns the result.
	 * `ResultGrid.vue` claims them from its own `onKeydown`, which runs first
	 * and marks the event `defaultPrevented`, so there is still one path; with
	 * no grid focused they resolve to ids that have no implementation.
	 */
	{
		id: "result.sortAsc",
		label: "Sort column ascending",
		group: "Result grid",
		defaultBinding: {
			key: "ArrowUp",
			meta: false,
			ctrl: true,
			shift: true,
			alt: false,
		},
	},
	{
		id: "result.sortDesc",
		label: "Sort column descending",
		group: "Result grid",
		defaultBinding: {
			key: "ArrowDown",
			meta: false,
			ctrl: true,
			shift: true,
			alt: false,
		},
	},
	{
		id: "result.rerun",
		label: "Refresh result",
		group: "Result grid",
		defaultBinding: accel("r"),
	},
	/*
	 * Dispatched by the window shell, unlike the grid-owned chords above: the
	 * WHERE box it focuses is fed by the grid, but the chord has to work from
	 * anywhere, not only while a cell holds focus. The shell reaches the box
	 * through `focusResultFilter`, which reports whether a filter bar was on
	 * screen; a query tab has none, so the chord is left to the webview there.
	 */
	{
		id: "result.focusWhere",
		label: "Focus WHERE filter",
		group: "Result grid",
		defaultBinding: accel("l"),
	},
];

/** Static id → command lookup, built from the table so an entry cannot be missing. */
const COMMANDS_BY_ID = Object.fromEntries(
	SHORTCUT_COMMANDS.map((command) => [command.id, command]),
) as Record<CommandId, CommandDefinition>;

function defaultBindingFor(id: CommandId): ShortcutBinding {
	return COMMANDS_BY_ID[id]?.defaultBinding ?? accel("");
}

/** Field-by-field validation: one bad field rejects that whole entry. */
function isBinding(value: unknown): value is ShortcutBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.key === "string" &&
		candidate.key.trim() !== "" &&
		typeof candidate.meta === "boolean" &&
		typeof candidate.ctrl === "boolean" &&
		typeof candidate.shift === "boolean" &&
		typeof candidate.alt === "boolean"
	);
}

type BindingMap = Partial<Record<CommandId, ShortcutBinding>>;

/**
 * Reads the persisted overrides. Anything that is not a usable object yields
 * an empty map (all defaults); individual unusable entries are simply not
 * copied over, so they fall back to their default too.
 */
function readPersisted(): BindingMap {
	let raw: string | null;
	try {
		raw = localStorage.getItem(STORAGE_KEY);
	} catch {
		return {};
	}
	if (raw === null) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const stored: BindingMap = {};
	for (const command of SHORTCUT_COMMANDS) {
		const entry = (parsed as Record<string, unknown>)[command.id];
		if (isBinding(entry)) stored[command.id] = { ...entry };
	}
	return stored;
}

function writePersisted(map: BindingMap): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
	} catch {
		// A full or blocked storage must not break the dialog; the binding still
		// lives in memory for this session.
	}
}

const bindings = ref<BindingMap>(readPersisted());

/**
 * True while a capture surface owns the keyboard. The dispatcher asks through
 * `match`, which is the only place this is honoured, so recording a new chord
 * can never also run the command it names.
 */
const suspend = ref(false);

/** The command implementations, registered by App.vue at mount. */
const registry = new Map<CommandId, () => void | boolean>();

/** Overwrites by design: a re-mounting App must not dispatch into a stale handler. */
export function registerCommand(id: CommandId, run: () => void | boolean): void {
	registry.set(id, run);
}

/**
 * Runs a command and reports whether anything was there to run.
 *
 * The return value is load-bearing for the window dispatcher: a chord that
 * resolves to a command with no registered implementation must NOT be claimed
 * with `preventDefault`, or the app would swallow a key it is not acting on.
 * Grid-scoped commands rely on this — they live in the table so they are
 * rebindable and printable, but their implementation sits in the grid, which
 * claims the chord itself when it holds focus and lets it through otherwise.
 *
 * An implementation may also answer `false` when it is present but has nothing
 * to act on this time (the filter bar's focus chord on a result with no WHERE
 * box): the chord still falls through rather than being swallowed on a dead end.
 */
export function runCommand(id: CommandId): boolean {
	const run = registry.get(id);
	if (!run) return false;
	return run() !== false;
}

const ARROWS: Record<string, string> = {
	ArrowLeft: "←",
	ArrowRight: "→",
	ArrowUp: "↑",
	ArrowDown: "↓",
};

/** A single letter prints uppercase; a named key prints as macOS writes it. */
function renderKey(key: string): string {
	const arrow = ARROWS[key];
	if (arrow) return arrow;
	return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * Renders a binding the way the running platform writes shortcuts. macOS puts
 * the symbols in a fixed order with no separators (`⌘⇧W`); elsewhere they are
 * spelled out and joined with `+` (`Ctrl+Shift+W`). Modifier order is always
 * Ctrl, Alt, Shift, then the accel, then the key — on both platforms.
 *
 * A modifier that is not held is not printed, on either branch: the accel is
 * whatever the platform put there, and a binding can deliberately name none of
 * it (Option+Shift+F does), so printing an accel symbol for one would name a
 * key that is not part of the chord.
 */
export function formatBinding(binding: ShortcutBinding): string {
	if (!IS_MAC) {
		const parts: string[] = [];
		if (binding.ctrl) parts.push("Ctrl");
		if (binding.alt) parts.push("Alt");
		if (binding.shift) parts.push("Shift");
		// The accel is `Ctrl` everywhere off macOS, so it is already above;
		// only a hand-made `Meta` binding still needs naming.
		if (binding.meta) parts.push("Meta");
		parts.push(binding.key);
		return parts.join("+");
	}
	const symbols: string[] = [];
	if (binding.meta) symbols.push("⌘");
	if (binding.ctrl) symbols.push("⌃");
	if (binding.alt) symbols.push("⌥");
	if (binding.shift) symbols.push("⇧");
	symbols.push(renderKey(binding.key));
	return symbols.join("");
}

/** The recorded identity of an event's key, shared by the matcher and the recorder. */
function normalizedKey(event: KeyboardEvent): string | null {
	const key = event.key;
	if (typeof key !== "string" || key === "") return null;
	return key.length === 1 ? key.toLowerCase() : key;
}

function sameBinding(a: ShortcutBinding, b: ShortcutBinding): boolean {
	return (
		a.key === b.key &&
		a.meta === b.meta &&
		a.ctrl === b.ctrl &&
		a.shift === b.shift &&
		a.alt === b.alt
	);
}

export function useShortcuts() {
	function bindingFor(id: CommandId): ShortcutBinding {
		return bindings.value[id] ?? defaultBindingFor(id);
	}

	function labelFor(id: CommandId): string {
		return COMMANDS_BY_ID[id]?.label ?? id;
	}

	/**
	 * Persists a rebind. A chord is only ever one command's: if another
	 * command already holds this exact binding its override is deleted so it
	 * falls back to a default rather than colliding.
	 */
	function setBinding(id: CommandId, binding: ShortcutBinding): void {
		const next: BindingMap = { ...bindings.value };
		for (const command of SHORTCUT_COMMANDS) {
			if (command.id === id) continue;
			const existing = next[command.id];
			if (existing && sameBinding(existing, binding)) delete next[command.id];
		}
		next[id] = { ...binding };
		bindings.value = next;
		writePersisted(next);
	}

	function unbind(id: CommandId): void {
		if (bindings.value[id] === undefined) return;
		const next = { ...bindings.value };
		delete next[id];
		bindings.value = next;
		writePersisted(next);
	}

	function resetBinding(id: CommandId): void {
		unbind(id);
	}

	function resetAll(): void {
		bindings.value = {};
		writePersisted({});
	}

	/**
	 * The dispatcher. Exact on all four modifier flags — that is what keeps
	 * `⌘W` from firing on `⌘⇧W` — and case-insensitive on a single character,
	 * so a recorder that stored `"w"` still matches a press of `"W"`.
	 *
	 * A binding that names a letter also matches the physical key behind a
	 * character the layout substituted for it, which is the only way
	 * `Option-Shift-F` can mean the F key on a keyboard that reports `Ï`.
	 */
	function match(event: KeyboardEvent): CommandId | null {
		if (suspend.value) return null;
		if (event.defaultPrevented) return null;
		const key = normalizedKey(event);
		if (key === null) return null;
		// A layout translates a letter into another character under some
		// modifiers — macOS reports `Ï` for `Option-Shift-F`, the way `Shift-1`
		// reports `!` — so the physical key is read too. Only when the event
		// named no ordinary letter, so a layout whose letters sit on other keys
		// (Dvorak) still matches the character it actually typed.
		const physical = /^[a-z]$/.test(key)
			? null
			: (/^Key([A-Z])$/.exec(event.code)?.[1].toLowerCase() ?? null);
		for (const command of SHORTCUT_COMMANDS) {
			const binding = bindingFor(command.id);
			if (
				(binding.key === key || binding.key === physical) &&
				binding.meta === event.metaKey &&
				binding.ctrl === event.ctrlKey &&
				binding.shift === event.shiftKey &&
				binding.alt === event.altKey
			) {
				return command.id;
			}
		}
		return null;
	}

	return {
		bindings: bindings as Readonly<Ref<BindingMap>>,
		suspend,
		bindingFor,
		labelFor,
		setBinding,
		unbind,
		resetBinding,
		resetAll,
		match,
		normalizedKey,
	};
}
