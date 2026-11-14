<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED ENVS
	import { enhance } from '$app/forms';
	// IMPORTED MODULES
	import Button from '#lib/ui/Button.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import { toastEnhance } from '#lib/ui/toastEnhance.js';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- STATES -- //

	let busy = $state(false);

	// -- FUNCTIONS -- //

	// A fixed zone, so the server and the browser print the same date
	const day = (iso: string) =>
		new Date(iso).toLocaleDateString('en-GB', {
			day: 'numeric',
			month: 'long',
			year: 'numeric',
			timeZone: 'UTC'
		});
</script>

<svelte:head><title>{data.org.name} is scheduled for deletion</title></svelte:head>

<PageFrame class="pb-12">
	<PageHeader
		title={`${data.org.name} is scheduled for deletion`}
		context={data.purging
			? 'It is being erased now.'
			: `It will be erased on ${day(data.purgeAt)} (UTC).`}
		testid="deleted-title"
	/>

	<section
		class="flex flex-col gap-4 rounded-xl border border-line bg-surface p-6 max-sm:p-3.5"
		data-card
		data-testid="deleted-panel"
	>
		<h2 class="text-lg font-semibold">What this means</h2>
		<p class="text-[15px] leading-6">
			An owner deleted this organisation on {day(data.deletedAt)}. Nobody can open its projects, and
			its tokens, runners and connected tools have stopped. Everything inside it is erased for good
			when the date above comes.
		</p>
		{#if data.purging}
			<Notice tone="warning" data-testid="deleted-purging">
				The erase has started, so the organisation can no longer be restored.
			</Notice>
		{:else if data.isOwner}
			<p class="text-[15px] leading-6">
				You are an owner, so you can bring it back. Everything returns as it was.
			</p>
			<form
				method="POST"
				action="?/restore"
				use:enhance={toastEnhance({
					id: 'restore-organisation',
					loading: 'Restoring the organisation...',
					success: 'Organisation restored.',
					inline: true,
					reset: true,
					onStart: () => (busy = true),
					onDone: () => (busy = false)
				})}
			>
				<Button type="submit" variant="primary" loading={busy} data-testid="restore-org"
					>Restore this organisation</Button
				>
			</form>
		{:else}
			<p class="text-[15px] leading-6 text-muted" data-testid="deleted-ask-owner">
				Only an owner can bring it back. Ask one of the owners before the date above.
			</p>
		{/if}
		{#if form?.message}
			<p role="alert" class="text-sm text-danger" data-testid="restore-error">{form.message}</p>
		{/if}
	</section>
</PageFrame>
