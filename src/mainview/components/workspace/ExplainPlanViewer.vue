<script setup lang="ts">
/**
 * Frame around the three EXPLAIN plan views: the node canvas, the operator tree,
 * and the server's own raw answer. The default view follows the plan shape — a
 * parsed plan with nodes opens on the canvas, a plan whose parser produced no
 * nodes (a text-only engine) opens on raw rather than an empty canvas. The raw
 * view always shows the statement that was run alongside the server's answer.
 */
import { computed, ref, watch } from "vue";
import { AlertCircle, Braces, Copy, FileText, GitBranch, Loader2, Workflow } from "lucide-vue-next";
import { Button } from "../ui/button";
import { toast } from "../../composables/useToast";
import type { ExplainPlan, ExplainPlanNode } from "../../../shared/types";
import ExplainPlanDiagram from "./ExplainPlanDiagram.vue";
import ExplainPlanNodeTree from "./ExplainPlanNodeTree.vue";

const props = defineProps<{
	plan: ExplainPlan | null;
	error: string | null;
	loading: boolean;
	/** The EXPLAIN statement that was run, shown in the raw view. */
	sql: string;
}>();

type PlanView = "canvas" | "tree" | "raw";

const activeView = ref<PlanView>("raw");

watch(
	() => props.plan,
	(plan) => {
		activeView.value = plan && plan.nodes.length > 0 ? "canvas" : "raw";
	},
	{ immediate: true },
);

function countPlanNodes(nodes: ExplainPlanNode[]): number {
	let total = 0;
	for (const node of nodes) total += 1 + countPlanNodes(node.children);
	return total;
}

const nodeCount = computed(() => (props.plan ? countPlanNodes(props.plan.nodes) : 0));

const rawText = computed(() => {
	const raw = props.plan?.raw;
	if (raw === undefined || raw === null) return "";
	// Text engines hand back their plan as a string → print it verbatim.
	if (typeof raw === "string") return raw;
	return JSON.stringify(raw, null, 2);
});

/** The node's measured row count, when the plan carries one. */
function actualRowsOf(node: ExplainPlanNode): string | undefined {
	for (const detail of node.details) {
		const match = detail.match(/Actual Rows:\s*(\S+)/);
		if (match) return match[1];
	}
	return undefined;
}

/**
 * Appends the operator tree as plain text, one node per line, indented by
 * depth. The fields are the ones the tree rows show, so a copied tree reads
 * like the tree on screen rather than a second, differently worded view.
 */
function appendTreeLines(nodes: ExplainPlanNode[], depth: number, lines: string[]): void {
	for (const node of nodes) {
		const parts = [node.nodeType];
		if (node.relation) parts.push(node.relation);
		if (node.index) parts.push(`[${node.index}]`);
		if (node.cost) parts.push(`c:${node.cost}`);
		if (node.rows) parts.push(`e:${node.rows}`);
		const actual = actualRowsOf(node);
		if (actual) parts.push(`a:${actual}`);
		lines.push(`${"  ".repeat(depth)}${parts.join(" ")}`);
		appendTreeLines(node.children, depth + 1, lines);
	}
}

/** The tree as text, for the tree view's copy button. */
const treeText = computed(() => {
	if (!props.plan) return "";
	const lines: string[] = [];
	appendTreeLines(props.plan.nodes, 0, lines);
	return lines.join("\n");
});

/** Copies a view's contents, reporting either outcome so the button is never
 *  a silent no-op on a locked-down clipboard. */
async function copyText(text: string, noun: string): Promise<void> {
	if (!text) return;
	try {
		await navigator.clipboard.writeText(text);
		toast(`${noun} copied`);
	} catch {
		toast(`Could not copy the ${noun.toLowerCase()}`);
	}
}
</script>

<template>
	<div class="flex h-full min-h-0 flex-col bg-background">
		<div class="flex h-9 shrink-0 items-center gap-2 overflow-x-auto overflow-y-hidden border-b px-3 text-xs">
			<span class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border bg-muted px-2 py-0.5 font-medium">
				<GitBranch class="h-3.5 w-3.5" aria-hidden="true" />
				Explain plan
			</span>
			<span v-if="plan" class="shrink-0 whitespace-nowrap text-muted-foreground">{{ nodeCount }} {{ nodeCount === 1 ? "node" : "nodes" }}</span>
			<span class="min-w-2 flex-1" />
			<div v-if="plan" class="inline-flex shrink-0 rounded-md border bg-muted/40 p-0.5">
				<Button size="sm" :variant="activeView === 'canvas' ? 'secondary' : 'ghost'" class="h-6 gap-1 px-2 text-xs" @click="activeView = 'canvas'">
					<Workflow class="h-3.5 w-3.5" aria-hidden="true" />
					Canvas
				</Button>
				<Button size="sm" :variant="activeView === 'tree' ? 'secondary' : 'ghost'" class="h-6 gap-1 px-2 text-xs" @click="activeView = 'tree'">
					<GitBranch class="h-3.5 w-3.5" aria-hidden="true" />
					Tree
				</Button>
				<Button size="sm" :variant="activeView === 'raw' ? 'secondary' : 'ghost'" class="h-6 gap-1 px-2 text-xs" @click="activeView = 'raw'">
					<FileText v-if="typeof plan.raw === 'string'" class="h-3.5 w-3.5" aria-hidden="true" />
					<Braces v-else class="h-3.5 w-3.5" aria-hidden="true" />
					Raw
				</Button>
			</div>
		</div>

		<div v-if="loading" class="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
			<Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
			Explaining…
		</div>

		<div v-else-if="error" class="min-h-0 flex-1 overflow-auto p-3">
			<div class="mx-auto flex max-w-2xl flex-col gap-2">
				<div class="flex items-start gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
					<AlertCircle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
					<span>{{ error }}</span>
				</div>
				<pre v-if="sql" class="overflow-auto whitespace-pre rounded border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-muted-foreground">{{ sql }}</pre>
			</div>
		</div>

		<div v-else-if="!plan" class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">No explain plan yet.</div>

		<div v-else-if="activeView === 'canvas'" class="min-h-0 flex-1">
			<ExplainPlanDiagram :nodes="plan.nodes" />
		</div>

		<div v-else-if="activeView === 'tree'" class="flex min-h-0 flex-1 flex-col">
			<div class="flex h-8 shrink-0 items-center justify-end border-b px-3">
				<Button
					size="sm"
					variant="ghost"
					class="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
					:disabled="!treeText"
					@click="copyText(treeText, 'Tree')"
				>
					<Copy class="h-3.5 w-3.5" aria-hidden="true" />
					Copy
				</Button>
			</div>
			<div class="min-h-0 flex-1 overflow-auto">
				<div class="mx-auto max-w-5xl space-y-px p-2">
					<ExplainPlanNodeTree v-for="node in plan.nodes" :key="node.id" :node="node" />
				</div>
			</div>
		</div>

		<div v-else class="min-h-0 flex-1 overflow-auto">
			<div class="space-y-2 p-3">
				<div v-if="sql">
					<div class="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">SQL</div>
					<pre class="overflow-auto whitespace-pre rounded border bg-muted/30 p-3 font-mono text-xs leading-relaxed">{{ sql }}</pre>
				</div>
				<div v-if="rawText">
					<div class="mb-1 flex items-center justify-between">
						<span class="text-[10px] uppercase tracking-wide text-muted-foreground">Raw plan</span>
						<Button
							size="xs"
							variant="ghost"
							class="h-5 gap-1 px-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground"
							@click="copyText(rawText, 'Raw plan')"
						>
							<Copy class="h-3 w-3" aria-hidden="true" />
							Copy
						</Button>
					</div>
					<pre class="overflow-auto whitespace-pre rounded border bg-muted/30 p-3 font-mono text-xs leading-relaxed">{{ rawText }}</pre>
				</div>
			</div>
		</div>
	</div>
</template>
