<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
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
			await api(org, `/sessions/${data.sessionId}/undo`, { method: 'POST', body: {} });
			toast.success('Everything that session changed is undone.');
			await invalidate('afb:project');
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The session could not be undone.');
		}
	}
</script>

<svelte:head><title>Activity, {data.summary?.project.name ?? ''}</title></svelte:head>

<div class="mx-auto flex max-w-[960px] flex-col gap-4 px-4 py-6 max-sm:px-3.5">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<h1 class="text-xl leading-7 font-semibold sm:text-2xl sm:leading-8" data-testid="page-title">
			Activity
		</h1>
		{#if data.sessionId}
			<div class="flex items-center gap-2">
				<a class="text-sm text-accent-text hover:underline" href={`/${org}/${key}/activity`}
					>Show everything</a
				>
				{#if canWrite}<Button size="sm" variant="danger" onclick={undoSession}
						>Undo this session</Button
					>{/if}
			</div>
		{/if}
	</div>
	<p class="text-sm text-muted">
		{data.sessionId
			? 'Only what one agent session changed.'
			: 'Everything that changed in this project, newest first. Most changes can be undone.'}
	</p>
	<EventList
		events={data.events}
		{org}
		refs={data.refs}
		linkBase={`/${org}/${key}`}
		canUndo={canWrite}
		onchanged={() => invalidate('afb:project')}
	/>
</div>
