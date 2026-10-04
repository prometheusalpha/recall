<script setup lang="ts">
/**
 * Unsaved-changes confirmation for tab closes.
 *
 * Mounted once for the whole window and driven entirely by the shared queue in
 * `useTabClose()`, because the question can be raised from several places —
 * a pill's close button, the strip's context menu, a keyboard shortcut — and
 * two dialogs competing over the same tabs would be worse than none.
 */
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { useTabClose } from "../../composables/useTabClose";

const { pendingTitles, dialogOpen, cancel, discardAndClose, saveAndClose } =
	useTabClose();
</script>

<template>
	<Dialog v-model:open="dialogOpen">
		<DialogContent class="sm:max-w-md">
			<DialogHeader>
				<DialogTitle>Unsaved changes</DialogTitle>
				<DialogDescription>
					<template v-if="pendingTitles.length > 1">
						{{ pendingTitles.length }} tabs have SQL that has not been
						saved ({{ pendingTitles.join(", ") }}). Save them, discard them, or
						go back to editing?
					</template>
					<template v-else-if="pendingTitles.length === 1">
						{{ pendingTitles[0] }} has SQL that has not been saved. Save it,
						discard it, or go back to editing?
					</template>
				</DialogDescription>
			</DialogHeader>
			<DialogFooter>
				<Button variant="ghost" @click="cancel">Cancel</Button>
				<Button variant="destructive" @click="discardAndClose">Discard</Button>
				<Button variant="default" @click="saveAndClose">Save</Button>
			</DialogFooter>
		</DialogContent>
	</Dialog>
</template>