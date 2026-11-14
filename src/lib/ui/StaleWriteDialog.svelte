<script lang="ts">
	// IMPORTED MODULES
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		changedBy,
		changedAt,
		onreload,
		oncompare
	}: {
		open: boolean;
		onclose: () => void;
		/** Who saved the newer version. */
		changedBy: string;
		changedAt: string;
		/** Throws away your edit and shows the newer version. */
		onreload: () => void;
		/** Keeps your edit and shows the two versions side by side. */
		oncompare: () => void;
	} = $props();
</script>

<ResponsiveModal {open} {onclose} title="Someone else changed this" size="sm">
	<p>
		{changedBy} saved a newer version at {changedAt}. Your change was not saved, so nothing was
		overwritten.
	</p>
	{#snippet footer()}
		<Button variant="secondary" onclick={oncompare}>Compare</Button>
		<Button variant="primary" onclick={onreload}>Reload their version</Button>
	{/snippet}
</ResponsiveModal>
