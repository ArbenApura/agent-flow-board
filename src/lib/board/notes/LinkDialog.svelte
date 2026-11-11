<script lang="ts">
	// -- TYPES -- //
	import type { LinkKind, Target } from '#lib/board/notes/links.js';
	// -- COMPONENTS -- //
	import LinkPicker from '#lib/board/notes/LinkPicker.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		title,
		org,
		project,
		label,
		onpick,
		kinds,
		selfId,
		linked = []
	}: {
		open: boolean;
		onclose: () => void;
		/** The heading of the dialog: Add a link, or Link a note. */
		title: string;
		org: string;
		project: string;
		/** The question over the search field. */
		label: string;
		/** Links the chosen one. Returns a plain message when it could not, and nothing when it did. A link closes the dialog. */
		onpick: (target: Target) => Promise<string | null | void>;
		/** The kinds worth offering. All four when left out. */
		kinds?: LinkKind[];
		/** The note this dialog belongs to, which is never offered to itself. */
		selfId?: string;
		/** What is linked already, so it is not offered again. */
		linked?: { kind: LinkKind; id: string }[];
	} = $props();

	// -- STATES -- //

	let busy = $state(false);

	// -- FUNCTIONS -- //

	/** A pick links at once. A refusal stays in the dialog, a link closes it. */
	async function pick(target: Target): Promise<string | null | void> {
		busy = true;
		try {
			const refused = await onpick(target);
			if (!refused) onclose();
			return refused;
		} finally {
			busy = false;
		}
	}
</script>

<!-- ADD A LINK: THE SEARCH AND ITS RESULTS IN A DIALOG, A BOTTOM SHEET ON A PHONE. THE SEARCH STARTS AGAIN EACH TIME IT OPENS, BECAUSE THE BODY IS MOUNTED WITH THE DIALOG -->
<ResponsiveModal {open} {onclose} {title} size="md" {busy}>
	<LinkPicker {org} {project} {label} {kinds} {selfId} {linked} onpick={pick} />
	{#snippet footer()}
		<Button onclick={onclose} disabled={busy} class="text-sm">Cancel</Button>
	{/snippet}
</ResponsiveModal>
