<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import { ApiError, api } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const empty = $derived(
		!!data.trash &&
			data.trash.items.length + data.trash.tasks.length + data.trash.attachments.length === 0
	);

	// -- FUNCTIONS -- //

	async function restoreFile(id: string, name: string) {
		try {
			await api(org, `/attachments/${id}/restore`, { method: 'POST', body: {} });
			toast.success(`${name} is back.`);
			await invalidate('afb:project');
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The file was not restored.');
		}
	}

	async function restore(ref: string) {
		try {
			await api(org, `/items/${ref}/restore`, { method: 'POST', body: {} });
			toast.success(`${ref} is back.`);
			await invalidate('afb:project');
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The item was not restored.');
		}
	}
</script>

<svelte:head><title>Trash, {data.summary?.project.name ?? ''}</title></svelte:head>

<div class="mx-auto flex max-w-[960px] flex-col gap-4 px-4 py-6 max-sm:px-3.5">
	<h1 class="text-xl leading-7 font-semibold sm:text-2xl sm:leading-8" data-testid="page-title">
		Trash
	</h1>
	{#if data.denied}
		<PermissionDenied needed={data.denied.needed} current={data.denied.role} what="the trash" />
	{:else if empty}
		<EmptyState
			title="The trash is empty"
			text="Items and files you remove stay here for 30 days, so you can bring them back."
		/>
	{:else if data.trash}
		<p class="text-sm text-muted">Things stay here for 30 days, then they are removed for good.</p>
		{#if data.trash.items.length}
			<section class="flex flex-col gap-2" aria-label="Items in the trash">
				<h2 class="text-base leading-6 font-semibold sm:text-lg sm:leading-[26px]">Items</h2>
				<ul class="rounded-xl border border-line bg-surface" data-testid="trash-items">
					{#each data.trash.items as i (i.id)}
						<li
							class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
							data-row
						>
							<span class="w-24 shrink-0 font-mono text-xs text-muted">{i.ref}</span>
							<span class="min-w-0 flex-1 text-sm"
								>{i.title}
								<span class="block text-xs text-muted"
									>Removed {i.deletedAt ? ago(i.deletedAt) : ''}, {i.daysLeft} days left</span
								></span
							>
							<Button size="sm" onclick={() => restore(i.ref)} data-testid="restore">Restore</Button
							>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if data.trash.tasks.length}
			<section class="flex flex-col gap-2" aria-label="Tasks in the trash">
				<h2 class="text-base leading-6 font-semibold sm:text-lg sm:leading-[26px]">Tasks</h2>
				<ul class="rounded-xl border border-line bg-surface">
					{#each data.trash.tasks as t (t.id)}
						<li
							class="flex items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0"
						>
							<span class="w-12 shrink-0 font-mono text-xs text-muted">T-{t.number}</span>
							<span class="min-w-0 flex-1">{t.title}</span>
							<span class="text-xs text-muted">{t.daysLeft} days left</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if data.trash.attachments.length}
			<section class="flex flex-col gap-2" aria-label="Files in the trash">
				<h2 class="text-base leading-6 font-semibold sm:text-lg sm:leading-[26px]">Files</h2>
				<ul class="rounded-xl border border-line bg-surface">
					{#each data.trash.attachments as a (a.id)}
						<li
							class="flex items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0"
						>
							<span class="min-w-0 flex-1 truncate">{a.filename}</span>
							<span class="text-xs text-muted">{a.daysLeft} days left</span>
							<Button size="sm" onclick={() => restoreFile(a.id, a.filename)}>Restore</Button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
	<a class="text-sm text-accent-text hover:underline" href={`/${org}/${key}`}
		>Back to the registry</a
	>
</div>
