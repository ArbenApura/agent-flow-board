<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- MODULES -- //
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		title,
		children,
		confirmLabel,
		cancelLabel = 'Cancel',
		tone = 'primary',
		confirmDisabled = false,
		onconfirm
	}: {
		open: boolean;
		onclose: () => void;
		title: string;
		/** Says what will happen and who it affects. */
		children: Snippet;
		confirmLabel: string;
		cancelLabel?: string;
		tone?: 'primary' | 'danger';
		/** Keeps the confirm button off until the dialog's own field is filled in correctly. */
		confirmDisabled?: boolean;
		/** Runs while the buttons show a busy state. The dialog closes only after it succeeds. */
		onconfirm: () => void | Promise<void>;
	} = $props();

	// -- STATES -- //

	let busy = $state(false);
	let error = $state<string | null>(null);

	// -- REACTIVE STATEMENTS -- //

	// A message from an earlier try does not greet the next one
	$effect(() => {
		if (open) error = null;
	});

	// -- FUNCTIONS -- //

	async function confirm() {
		busy = true;
		error = null;
		try {
			await onconfirm();
			onclose();
		} catch (e) {
			// On failure the dialog stays open and says why
			error = e instanceof Error ? e.message : 'That did not work. Try again.';
		} finally {
			busy = false;
		}
	}
</script>

<ResponsiveModal {open} {onclose} {title} {busy} size="sm">
	{@render children()}
	{#if error}<p role="alert" class="mt-3 text-sm text-danger">{error}</p>{/if}
	{#snippet footer()}
		<Button variant="secondary" disabled={busy} onclick={onclose}>{cancelLabel}</Button>
		<Button
			variant={tone === 'danger' ? 'danger' : 'primary'}
			loading={busy}
			disabled={confirmDisabled}
			onclick={confirm}
		>
			{confirmLabel}
		</Button>
	{/snippet}
</ResponsiveModal>
