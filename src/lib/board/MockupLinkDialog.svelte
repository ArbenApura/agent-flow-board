<script lang="ts">
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		org,
		mockupId,
		currentRef,
		onchange
	}: {
		open: boolean;
		onclose: () => void;
		org: string;
		mockupId: string;
		/** The plan it belongs to now, or null. */
		currentRef: string | null;
		onchange: () => Promise<void>;
	} = $props();

	// -- STATES -- //

	let ref = $state('');
	let error = $state('');
	let busy = $state(false);
	let prevOpen = false;

	// -- FUNCTIONS -- //

	async function save(next: string | null) {
		error = '';
		busy = true;
		try {
			await api(org, `/mockups/${mockupId}/link`, {
				method: 'POST',
				body: { item: next },
				key: newKey()
			});
			toast.success(next ? `Linked to ${next}.` : 'Taken off its plan.');
			await onchange();
			onclose();
		} catch (e) {
			// The dialog stays open so the person can fix the reference
			error = e instanceof ApiError ? e.message : 'That was not saved.';
		} finally {
			busy = false;
		}
	}

	// -- REACTIVE STATEMENTS -- //

	// The field starts from the plan the mockup is on each time the dialog opens, and is left alone while the person types
	$effect(() => {
		if (open && !prevOpen)
			untrack(() => {
				ref = currentRef ?? '';
				error = '';
			});
		prevOpen = open;
	});
</script>

<!-- LINK A MOCKUP TO A PLAN. THE PLAN TAKES OVER WHO MAY SEE THE MOCKUP -->
<ResponsiveModal {open} {onclose} title="Link to a plan" size="md" {busy}>
	<form
		id="mockup-link-form"
		class="flex flex-col gap-3"
		onsubmit={(e) => {
			e.preventDefault();
			if (ref.trim()) void save(ref.trim());
		}}
	>
		<TextField
			label="Which plan does this mockup belong to?"
			placeholder="AFB-20261107-0346"
			hint="The plan's reference. The mockup then shows in that plan's Mockups tab and follows who may see the plan."
			bind:value={ref}
			{error}
			class="font-mono"
			data-testid="mockup-link-ref"
		/>
	</form>
	{#snippet footer()}
		<div class="flex w-full flex-wrap items-center justify-end gap-2">
			{#if currentRef}
				<Button disabled={busy} onclick={() => save(null)} class="mr-auto"
					>Take it off its plan</Button
				>
			{/if}
			<Button disabled={busy} onclick={onclose}>Cancel</Button>
			<Button
				variant="primary"
				type="submit"
				form="mockup-link-form"
				loading={busy}
				disabled={!ref.trim() || ref.trim() === currentRef}>Link it</Button
			>
		</div>
	{/snippet}
</ResponsiveModal>
