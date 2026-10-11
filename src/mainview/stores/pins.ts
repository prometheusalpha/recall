/**
 * Pinned tables, as the renderer sees them.
 *
 * A pin is one table in one connection, addressed by (connectionId, database,
 * schema, table). The list lives in the app's SQLite database rather than in
 * `localStorage`, because it is small, shared state that must survive a window
 * reload without a second copy to reconcile.
 *
 * The list is read once per session: every mount of the sidebar tree calls
 * {@link usePinsStore}'s `hydrate`, but only the first one pays for the round
 * trip — the rest join the in-flight read, so switching between databases never
 * re-fetches the same rows.
 *
 * Every mutation returns the whole new list, which is swapped in wholesale. The
 * renderer never tries to guess the new order (the backend owns it), so no edit
 * can leave the sidebar showing a list that the database does not have.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { PinnedTable } from "../../shared/types";
import { errorMessage, RPC_TIMEOUTS, rpc } from "../lib/rpc";

/** The four coordinates that identify a pin. */
export type PinCoords = {
	connectionId: string;
	database: string;
	schema: string;
	table: string;
};

/**
 * In-flight (or finished) startup read; `null` until `hydrate` is called. Module
 * level so that every sidebar that mounts shares one read.
 */
let hydration: Promise<void> | null = null;

/**
 * Coordinates as one `Set` key. `\u0000` is used as the separator because it
 * cannot occur in an identifier, so two different coordinate tuples can never
 * collide even though a schema or table name may contain a `:`, a `.`, or
 * anything else.
 */
function pinKey(coords: PinCoords): string {
	return `${coords.connectionId}\u0000${coords.database}\u0000${coords.schema}\u0000${coords.table}`;
}

export const usePinsStore = defineStore("pins", () => {
	/** Pinned tables in the backend's order, first pinned first. */
	const pinned = ref<PinnedTable[]>([]);
	/**
	 * False until the stored pins have been read. The sidebar holds its empty
	 * state back until this flips, so a slow read cannot be mistaken for "this
	 * connection has no pins".
	 */
	const hydrated = ref(false);

	/** Membership test for {@link isPinned}; rebuilt only when the list changes. */
	const pinnedKeys = computed(
		() => new Set(pinned.value.map((entry) => pinKey(entry))),
	);

	/** Cheap because it only looks at the derived key set. */
	function isPinned(coords: PinCoords): boolean {
		return pinnedKeys.value.has(pinKey(coords));
	}

	/**
	 * Reads the stored pins once per session. Safe to call from every mount: the
	 * first caller owns the read and everyone else awaits the same promise. A
	 * failed read clears the promise so a later mount retries.
	 */
	function hydrate(): Promise<void> {
		hydration ??= (async () => {
			try {
				pinned.value = await rpc.request.listPinnedTables(
					{},
					{ maxRequestTime: RPC_TIMEOUTS.metadata },
				);
			} catch (err) {
				hydration = null;
				console.error("[recall] could not load pinned tables:", errorMessage(err));
			} finally {
				hydrated.value = true;
			}
		})();
		return hydration;
	}

	/**
	 * Pins or unpins one table and swaps in the list the backend returns. On
	 * failure the local list is left untouched: a refused write must not make
	 * the sidebar claim a pin that was never stored.
	 */
	async function togglePin(coords: PinCoords): Promise<void> {
		try {
			pinned.value = await rpc.request.setPinnedTable(
				{ ...coords, pinned: !isPinned(coords) },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
		} catch (err) {
			throw new Error(errorMessage(err));
		}
	}

	return { pinned, hydrated, hydrate, isPinned, togglePin };
});
