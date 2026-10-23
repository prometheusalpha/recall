/**
 * Cell edits the grid holds until the user commits them, keyed by row index and
 * *result* column index. Result columns rather than visible ones: hiding or
 * reordering a column must not move an edit onto a different column.
 */

export interface PendingEdit {
	row: number;
	resultCol: number;
	value: unknown;
}

export function editKey(row: number, resultCol: number): string {
	return `${row}:${resultCol}`;
}

/** Edits grouped per row, rows in ascending order so the UPDATEs run top to bottom. */
export function editsByRow(
	edits: Iterable<PendingEdit>,
): { row: number; edits: PendingEdit[] }[] {
	const byRow = new Map<number, PendingEdit[]>();
	for (const edit of edits) {
		const list = byRow.get(edit.row);
		if (list) list.push(edit);
		else byRow.set(edit.row, [edit]);
	}
	return [...byRow.entries()]
		.sort(([a], [b]) => a - b)
		.map(([row, list]) => ({
			row,
			edits: list.sort((a, b) => a.resultCol - b.resultCol),
		}));
}
