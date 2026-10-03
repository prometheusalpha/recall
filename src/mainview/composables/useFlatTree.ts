/** One row of a flattened tree, paired with its indentation level. */
export interface FlatTreeNode<T> {
	node: T;
	depth: number;
	key: string;
}

/**
 * Depth-first flattening of a tree whose children are fetched lazily.
 *
 * A node's children are visited only when its key is in `expanded`, so a
 * collapsed branch costs nothing to render. Pure: no state, no caching, no
 * mutation of the inputs — the caller re-derives the whole list on any change.
 */
export function flattenTree<T>(
	roots: T[],
	expanded: ReadonlySet<string>,
	getChildren: (node: T) => T[] | undefined,
	getKey: (node: T) => string,
): FlatTreeNode<T>[] {
	const result: FlatTreeNode<T>[] = [];

	function walk(nodes: T[], depth: number): void {
		for (const node of nodes) {
			const key = getKey(node);
			result.push({ node, depth, key });
			if (!expanded.has(key)) continue;
			const children = getChildren(node);
			if (children) walk(children, depth + 1);
		}
	}

	walk(roots, 0);
	return result;
}