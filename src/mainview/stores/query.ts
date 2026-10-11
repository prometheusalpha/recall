import { defineStore } from "pinia";
import { ref } from "vue";
import { errorMessage, RPC_TIMEOUTS, rpc } from "../lib/rpc";
import type { ExplainPlan, StatementResult } from "../../shared/types";
import { useConnectionsStore } from "./connections";
import { useTabsStore } from "./tabs";

/** Row cap handed to the backend; the grid shows a truncation badge past this. */
export const MAX_ROWS = 20000;

/**
 * A failed run is rendered as data, not thrown: the result set becomes a
 * single-cell "Error" grid so the error sits where the rows would be.
 */
function errorStatement(sql: string, message: string): StatementResult {
	return {
		statementIndex: 0,
		sql,
		columns: ["Error"],
		columnTypes: ["text"],
		rows: [[message]],
		affectedRows: 0,
		executionTimeMs: 0,
		truncated: false,
		error: { code: "ERR_CLIENT", message },
	};
}

export interface RunOptions {
	/** Run this SQL instead of the tab's committed SQL (e.g. a selection). */
	sqlOverride?: string;
}

/** Which of the two panes the result area is showing. */
export type ResultView = "result" | "explain";

/**
 * One tab's last explain attempt. The plan is `null` while the request is in
 * flight and after a rejected one, so `error` is what tells those two apart.
 */
export interface ExplainView {
	plan: ExplainPlan | null;
	error: string | null;
	/** The statement the plan is of, kept so the panel can show what it asked. */
	sql: string;
	loading: boolean;
}

export const useQueryStore = defineStore("query", () => {
	/** Results per tab; each entry is one entry per split statement. */
	const results = ref<Record<string, StatementResult[]>>({});
	const running = ref<Record<string, boolean>>({});
	const activeStatementIndex = ref<Record<string, number>>({});
	const totalTimeMs = ref<Record<string, number>>({});
	const executedSql = ref<Record<string, string>>({});

	/**
	 * In-flight execution ids, kept out of every persisted surface: they are
	 * only meaningful while a run is live, and `cancel` needs the current one.
	 */
	const executionIds = ref<Record<string, string>>({});

	/** The last explain per tab, and which pane that tab is showing. */
	const explainViews = ref<Record<string, ExplainView>>({});
	const resultViews = ref<Record<string, ResultView>>({});

	function writeFailure(tabId: string, sql: string, message: string) {
		results.value[tabId] = [errorStatement(sql, message)];
		totalTimeMs.value[tabId] = 0;
		activeStatementIndex.value[tabId] = 0;
		executedSql.value[tabId] = sql;
	}

	async function run(tabId: string, options?: RunOptions): Promise<void> {
		// One run per tab at a time; a second click is a no-op, not a queue.
		if (running.value[tabId]) return;
		const tab = useTabsStore().tabs.find((entry) => entry.id === tabId);
		if (!tab) return;

		const sql = options?.sqlOverride ?? tab.sql;
		running.value[tabId] = true;
		// A run replaces what the pane is about: leaving the explain view up
		// would hide the rows the user just asked for.
		resultViews.value[tabId] = "result";
		const executionId = crypto.randomUUID();
		executionIds.value[tabId] = executionId;

		try {
			const connections = useConnectionsStore();
			await connections.ensureConnected(tab.connectionId);
			const result = await rpc.request.execute(
				{
					connectionId: tab.connectionId,
					database: tab.database,
					schema: tab.schema,
					sql,
					executionId,
					maxRows: MAX_ROWS,
				},
				{ maxRequestTime: RPC_TIMEOUTS.execute },
			);
			results.value[tabId] = result.statements;
			totalTimeMs.value[tabId] = result.totalExecutionTimeMs;
			executedSql.value[tabId] = sql;
			activeStatementIndex.value[tabId] = 0;
		} catch (err) {
			writeFailure(tabId, sql, errorMessage(err));
		} finally {
			running.value[tabId] = false;
			delete executionIds.value[tabId];
		}
	}

	async function cancel(tabId: string): Promise<void> {
		const executionId = executionIds.value[tabId];
		if (!executionId) return;
		try {
			await rpc.request.cancelQuery({ executionId });
		} catch {
			// The run may already have finished; nothing left to cancel.
		}
	}

	/**
	 * Plan one statement without running it: the driver wraps it in `EXPLAIN`,
	 * which both engines answer from the optimiser alone, so this is safe to
	 * press on a statement that writes.
	 *
	 * The pane switches to the plan before the answer arrives, because that is
	 * where both the plan and the server's reason for having none belong.
	 */
	async function explain(tabId: string, sql: string): Promise<void> {
		const tab = useTabsStore().tabs.find((entry) => entry.id === tabId);
		if (!tab || sql.trim() === "") return;
		explainViews.value[tabId] = { plan: null, error: null, sql, loading: true };
		resultViews.value[tabId] = "explain";
		try {
			await useConnectionsStore().ensureConnected(tab.connectionId);
			const answer = await rpc.request.explain(
				{ connectionId: tab.connectionId, database: tab.database, sql },
				{ maxRequestTime: RPC_TIMEOUTS.metadata },
			);
			explainViews.value[tabId] = {
				plan: answer.plan,
				// A rejected plan carries the server's own explanation, detail
				// and all; a client-side failure has already been normalised.
				error:
					answer.error === null
						? null
						: [answer.error.message, answer.error.detail]
								.filter((part) => part)
								.join("\n"),
				sql: answer.plan?.sql ?? sql,
				loading: false,
			};
		} catch (err) {
			explainViews.value[tabId] = {
				plan: null,
				error: errorMessage(err),
				sql,
				loading: false,
			};
		}
	}

	function setResultView(tabId: string, view: ResultView): void {
		resultViews.value[tabId] = view;
	}

	function clear(tabId: string): void {
		delete results.value[tabId];
		delete running.value[tabId];
		delete activeStatementIndex.value[tabId];
		delete totalTimeMs.value[tabId];
		delete executedSql.value[tabId];
		delete executionIds.value[tabId];
		delete explainViews.value[tabId];
		delete resultViews.value[tabId];
	}

	return {
		results,
		running,
		activeStatementIndex,
		totalTimeMs,
		executedSql,
		explainViews,
		resultViews,
		run,
		cancel,
		explain,
		setResultView,
		clear,
	};
});
