import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

export type TabMode = "query" | "table";

export interface Tab {
	id: string;
	title: string;
	connectionId: string;
	database: string;
	schema: string;
	/** Only meaningful for mode === "table". */
	table: string;
	mode: TabMode;
	/** Committed SQL shown to the user for mode === "query". */
	sql: string;
	/**
	 * Absolute path of the `.sql` file this tab came from, when it was opened
	 * from one. A bookmark points at a file, not at a tab, so this is what
	 * tells the editor which bookmarks belong to the document on screen.
	 */
	path?: string;
	/** Snapshot taken when the tab was last saved/loaded; dirty = sql !== savedSql. */
	savedSql: string;
	pinned: boolean;
}

/** Identity used to dedupe tabs: two tabs for the same target are the same tab. */
export interface TabTarget {
	connectionId: string;
	database: string;
	schema: string;
	mode: TabMode;
	table: string;
}

/** Outcome of a close attempt, so callers can branch without re-inspecting state. */
export type CloseResult =
	| { closed: true; id: string }
	| { closed: false; id: string; reason: "dirty" | "missing" };

/** What a bulk close removed, and what it refused to remove because of SQL. */
export interface CloseOthersResult {
	closed: string[];
	dirtyIds: string[];
}

export interface OpenQueryTabOptions {
	connectionId: string;
	database: string;
	schema: string;
	sql?: string;
	/**
	 * Absolute path of the `.sql` file this tab is showing, when it was opened
	 * from one. Bookmarks are keyed by path, so the editor needs it.
	 */
	path?: string;
	/** Open a new tab even when one for the same target already exists. */
	forceNew?: boolean;
}

export interface OpenTableTabOptions {
	connectionId: string;
	database: string;
	schema: string;
	table: string;
	forceNew?: boolean;
}

const STORAGE_KEY = "recall.tabs";
const PERSIST_DEBOUNCE_MS = 300;

function isTab(value: unknown): value is Tab {
	if (!value || typeof value !== "object") return false;
	return (
		"id" in value &&
		typeof value.id === "string" &&
		"title" in value &&
		typeof value.title === "string" &&
		"connectionId" in value &&
		typeof value.connectionId === "string" &&
		"database" in value &&
		typeof value.database === "string" &&
		"schema" in value &&
		typeof value.schema === "string" &&
		"table" in value &&
		typeof value.table === "string" &&
		"mode" in value &&
		(value.mode === "query" || value.mode === "table") &&
		"sql" in value &&
		typeof value.sql === "string" &&
		"savedSql" in value &&
		typeof value.savedSql === "string" &&
		// Tabs persisted before bookmarks existed carry no path at all.
		(!("path" in value) ||
			value.path === undefined ||
			typeof value.path === "string") &&
		"pinned" in value &&
		typeof value.pinned === "boolean"
	);
}

function readPersisted(): { tabs: Tab[]; activeTabId: string | null } {
	let raw: string | null;
	try {
		raw = localStorage.getItem(STORAGE_KEY);
	} catch {
		return { tabs: [], activeTabId: null };
	}
	if (raw === null) return { tabs: [], activeTabId: null };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { tabs: [], activeTabId: null };
	}
	if (!parsed || typeof parsed !== "object") {
		return { tabs: [], activeTabId: null };
	}
	const rawTabs = "tabs" in parsed ? parsed.tabs : undefined;
	if (!Array.isArray(rawTabs)) return { tabs: [], activeTabId: null };
	const valid = rawTabs.filter(isTab);
	const rawActiveId = "activeTabId" in parsed ? parsed.activeTabId : undefined;
	return {
		tabs: valid,
		activeTabId:
			typeof rawActiveId === "string" &&
			valid.some((tab) => tab.id === rawActiveId)
			? rawActiveId
				: (valid[0]?.id ?? null),
	};
}

export const useTabsStore = defineStore("tabs", () => {
	const restored = readPersisted();
	const tabs = ref<Tab[]>(restored.tabs);
	const activeTabId = ref<string | null>(restored.activeTabId);

	const activeTab = computed<Tab | null>(
		() => tabs.value.find((tab) => tab.id === activeTabId.value) ?? null,
	);

	/** Derived, never stored: a tab is dirty when its SQL differs from the snapshot. */
	function isDirty(tab: Tab): boolean {
		return tab.sql !== tab.savedSql;
	}

	let persistTimer: ReturnType<typeof setTimeout> | undefined;
	watch(
		[tabs, activeTabId],
		() => {
			clearTimeout(persistTimer);
			persistTimer = setTimeout(() => {
				try {
					localStorage.setItem(
						STORAGE_KEY,
						JSON.stringify({
							tabs: tabs.value,
							activeTabId: activeTabId.value,
						}),
					);
				} catch {
					// Storage unavailable: tabs live for this session only.
				}
			}, PERSIST_DEBOUNCE_MS);
		},
		{ deep: true },
	);

	/**
	 * Whether `tab` already shows what the caller is about to open.
	 *
	 * A tab opened from a `.sql` file is identified by that file alone: the
	 * path IS the document. Dedupe used to key on the connection target alone,
	 * so two different files bound to the same datasource collided — opening
	 * the second silently reused the first one's tab and repointed its path at
	 * the second file, leaving the title showing B over A's text. A file is
	 * also never the same tab as a scratch query, however well the connection
	 * happens to match.
	 *
	 * A tab with no path is the other case: it is identified by the target it
	 * runs against, which is what `forceNew` opts out of.
	 */
	function isSameTab(
		tab: Tab,
		target: TabTarget,
		path: string | undefined,
	): boolean {
		if (path !== undefined || tab.path !== undefined) {
			return path !== undefined && tab.path === path;
		}
		return (
			tab.connectionId === target.connectionId &&
			tab.database === target.database &&
			tab.schema === target.schema &&
			tab.mode === target.mode &&
			tab.table === target.table
		);
	}

	function activate(id: string) {
		if (tabs.value.some((tab) => tab.id === id)) activeTabId.value = id;
	}

	/**
	 * Points an existing tab at `target`. Only the connection fields move: the
	 * document, its title and its dirty state belong to the file and survive a
	 * rebinding, so unsaved edits are never thrown away by changing datasource.
	 */
	function retarget(tab: Tab, target: TabTarget): void {
		tab.connectionId = target.connectionId;
		tab.database = target.database;
		tab.schema = target.schema;
	}

	/**
	 * Moves an open tab to another datasource from the UI. The document, its
	 * title and its dirty state stay put: only where the SQL runs changes, so
	 * unsaved edits survive a rebinding.
	 */
	function setTarget(id: string, target: TabTarget): void {
		const tab = tabs.value.find((entry) => entry.id === id);
		if (tab) retarget(tab, target);
	}

	function createTab(
		target: TabTarget,
		title: string,
		sql: string,
		path: Tab["path"],
	): Tab {
		return {
			id: crypto.randomUUID(),
			...(path ? { path } : {}),
			title,
			connectionId: target.connectionId,
			database: target.database,
			schema: target.schema,
			table: target.table,
			mode: target.mode,
			sql,
			savedSql: sql,
			pinned: false,
		};
	}

	function openQueryTab(options: OpenQueryTabOptions): Tab {
		const sql = options.sql ?? "";
		const target: TabTarget = {
			connectionId: options.connectionId,
			database: options.database,
			schema: options.schema,
			mode: "query",
			table: "",
		};
		if (!options.forceNew) {
			const existing = tabs.value.find((tab) =>
				isSameTab(tab, target, options.path),
			);
			if (existing) {
				retarget(existing, target);
				activate(existing.id);
				return existing;
			}
		}
		const tab = createTab(target, "Query", sql, options.path);
		tabs.value.push(tab);
		activate(tab.id);
		return tab;
	}

	function openTableTab(options: OpenTableTabOptions): Tab {
		const target: TabTarget = {
			connectionId: options.connectionId,
			database: options.database,
			schema: options.schema,
			mode: "table",
			table: options.table,
		};
		if (!options.forceNew) {
			const existing = tabs.value.find((tab) =>
				isSameTab(tab, target, undefined),
			);
			if (existing) {
				activate(existing.id);
				return existing;
			}
		}
		// A table tab is a read-only view; its "SQL" is the DDL snapshot, which
		// makes it dirty-proof and lets the grid render it like any other tab.
		const tab = createTab(target, options.table, "", undefined);
		tabs.value.push(tab);
		activate(tab.id);
		return tab;
	}

	function close(id: string, options?: { force?: boolean }): CloseResult {
		const index = tabs.value.findIndex((tab) => tab.id === id);
		if (index === -1) return { closed: false, id, reason: "missing" };
		if (isDirty(tabs.value[index]) && !options?.force) {
			return { closed: false, id, reason: "dirty" };
		}
		tabs.value.splice(index, 1);
		if (activeTabId.value === id) {
			const next = tabs.value[index] ?? tabs.value[index - 1] ?? null;
			activeTabId.value = next?.id ?? null;
		}
		return { closed: true, id };
	}

	/**
	 * Closes every tab except `id`, mirroring `close`'s dirtiness rule: without
	 * `force` a tab holding unsaved SQL is held back and reported in
	 * `dirtyIds`, so the caller can ask the user instead of losing work.
	 */
	function closeOthers(
		id: string,
		options?: { force?: boolean },
	): CloseOthersResult {
		if (!tabs.value.some((tab) => tab.id === id)) {
			return { closed: [], dirtyIds: [] };
		}
		const closed: string[] = [];
		const dirtyIds: string[] = [];
		// Original positions drive the active-tab handover, exactly like close.
		const kept = tabs.value.flatMap((tab, index) => {
			if (tab.id === id) return [{ tab, index }];
			if (isDirty(tab) && !options?.force) {
				dirtyIds.push(tab.id);
				return [{ tab, index }];
			}
			closed.push(tab.id);
			return [];
		});
		if (closed.length === 0) return { closed, dirtyIds };

		const activeIndex = tabs.value.findIndex(
			(tab) => tab.id === activeTabId.value,
		);
		const wasClosed = activeIndex !== -1 && closed.includes(tabs.value[activeIndex].id);
		tabs.value = kept.map((entry) => entry.tab);
		if (wasClosed) {
			// Neighbour of the vacated slot: the next tab along, else the one before.
			const next = kept.find((entry) => entry.index > activeIndex);
			const previous = kept.filter((entry) => entry.index < activeIndex).pop();
			activeTabId.value = (next ?? previous)?.tab.id ?? null;
		}
		return { closed, dirtyIds };
	}

	/** Closes every tab belonging to a connection that is going away. */
	function closeForConnection(connectionId: string): void {
		tabs.value = tabs.value.filter(
			(tab) => tab.connectionId !== connectionId,
		);
		if (
			activeTabId.value !== null &&
			!tabs.value.some((tab) => tab.id === activeTabId.value)
		) {
			activeTabId.value = tabs.value[0]?.id ?? null;
		}
	}

	function closeAll(): void {
		tabs.value = [];
		activeTabId.value = null;
	}

	function reorder(
		dragId: string,
		targetId: string,
		position: "before" | "after",
	): void {
		if (dragId === targetId) return;
		const from = tabs.value.findIndex((tab) => tab.id === dragId);
		const to = tabs.value.findIndex((tab) => tab.id === targetId);
		if (from === -1 || to === -1) return;
		const [moved] = tabs.value.splice(from, 1);
		if (!moved) return;
		// Removing the dragged tab shifts every later index down by one.
		const anchor = tabs.value.findIndex((tab) => tab.id === targetId);
		const insertAt = position === "before" ? anchor : anchor + 1;
		tabs.value.splice(insertAt, 0, moved);
	}

	function rename(id: string, title: string): void {
		const tab = tabs.value.find((entry) => entry.id === id);
		if (tab) tab.title = title;
	}

	function togglePin(id: string): void {
		const tab = tabs.value.find((entry) => entry.id === id);
		if (tab) tab.pinned = !tab.pinned;
	}

	/** Records the current SQL as the saved baseline, clearing the dirty state. */
	function markSaved(id: string): void {
		const tab = tabs.value.find((entry) => entry.id === id);
		if (tab) tab.savedSql = tab.sql;
	}

	return {
		tabs,
		activeTabId,
		activeTab,
		isDirty,
		openQueryTab,
		setTarget,
		openTableTab,
		activate,
		close,
		closeOthers,
		closeForConnection,
		closeAll,
		reorder,
		rename,
		togglePin,
		markSaved,
	};
});
