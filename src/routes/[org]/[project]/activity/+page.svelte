<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import { ApiError, api } from '#lib/board/api.js';
	import EventList from '#lib/board/EventList.svelte';
	import Button from '#lib/ui/Button.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const canWrite = $derived(data.summary?.caps.includes('write') ?? false);

	// -- FUNCTIONS -- //

	async function undoSession() {
		if (!data.sessionId) return;
		if (
			!(await askConfirm({
				title: 'Undo this whole session?',
				body: 'Everything the session changed is put back, newest change first, until one cannot be undone safely.',
				confirmLabel: 'Undo it all'
			}))
		)
			return;
		try {
			await toast.promise(
				api(org, `/sessions/${data.sessionId}/undo`, { method: 'POST', body: {} }),
				{
					loading: 'Undoing the session...',
					success: 'Everything that session changed is undone.',
					error: (e) => (e instanceof ApiError ? e.message : 'The session could not be undone.')
				}
			);
			await invalidate('afb:project');
		} catch {
			// The promise toast already shows the failure
		}
	}
</script>

<svelte:head><title>Activity, {data.summary?.project.name ?? ''}</title></svelte:head>

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader
		title="Activity"
		context={data.sessionId
			? 'Only what one agent session changed.'
			: 'Everything that changed in this project, newest first. Most changes can be undone.'}
	>
		{#snippet actions()}
			{#if data.sessionId}
				<a class="text-sm text-accent-text hover:underline" href={`/${org}/${key}/activity`}
					>Show everything</a
				>
				{#if canWrite}<Button size="sm" variant="danger" onclick={undoSession}
						>Undo this session</Button
					>{/if}
			{/if}
		{/snippet}
	</PageHeader>
	<EventList
		events={data.events}
		{org}
		refs={data.refs}
		linkBase={`/${org}/${key}`}
		canUndo={canWrite}
		onchanged={() => invalidate('afb:project')}
	/>
</PageFrame>
