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
			await toast.promise(api(org, `/attachments/${id}/restore`, { method: 'POST', body: {} }), {
				loading: `Restoring ${name}...`,
				success: `${name} is back.`,
				error: (e) => (e instanceof ApiError ? e.message : 'The file was not restored.')
			});
			await invalidate('afb:project');
		} catch {
			// The promise toast already shows the failure
		}
	}

	async function restoreTask(id: string, number: number) {
		try {
			await toast.promise(api(org, `/tasks/${id}/restore`, { method: 'POST', body: {} }), {
				loading: `Restoring T-${number}...`,
				success: `T-${number} is back.`,
				error: (e) => (e instanceof ApiError ? e.message : 'The task was not restored.')
			});
			await invalidate('afb:project');
		} catch {
			// The promise toast already shows the failure
		}
	}

	async function restore(ref: string) {
		try {
			await toast.promise(api(org, `/items/${ref}/restore`, { method: 'POST', body: {} }), {
				loading: `Restoring ${ref}...`,
				success: `${ref} is back.`,
				error: (e) => (e instanceof ApiError ? e.message : 'The item was not restored.')
			});
			await invalidate('afb:project');
		} catch {
			// The promise toast already shows the failure
		}
	}
</script>

<svelte:head><title>Trash, {data.summary?.project.name ?? ''}</title></svelte:head>

<!-- DAYS LEFT BADGE, WARNING TOKEN WHEN REMOVAL IS CLOSE -->
{#snippet daysBadge(days: number)}
	<span
		class={[
			'shrink-0 rounded-full border px-2 py-0.5 text-xs tabular-nums',
			days <= 5 ? 'border-[var(--warning)] text-[var(--warning)]' : 'border-line text-muted'
		]}>{days} {days === 1 ? 'day' : 'days'} left</span
	>
{/snippet}

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader
		class="mb-2!"
		title="Trash"
		context="Things stay here for 30 days, then they are removed for good."
		back={{ href: `/${org}/${key}`, label: 'Back to the registry' }}
	/>
	{#if data.denied}
		<PermissionDenied needed={data.denied.needed} current={data.denied.role} what="the trash" />
	{:else if empty}
		<!-- THE EMPTY STATE SITS IN ITS OWN CARD SO IT READS AS PART OF THE PAGE -->
		<div
			class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
			data-testid="trash-empty"
		>
			<EmptyState
				kind="trash"
				title="The trash is empty"
				text="Items and files you remove stay here for 30 days, so you can bring them back."
			>
				{#snippet action()}
					<Button href={`/${org}/${key}`}>Go to the registry</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else if data.trash}
		{#if data.trash.items.length}
			<section class="flex flex-col gap-2" aria-label="Items in the trash">
				<h2 class="flex items-center gap-2 text-lg font-semibold">
					Items
					<span
						class="rounded-full bg-raised px-2 py-0.5 text-xs font-medium text-muted tabular-nums"
						>{data.trash.items.length}</span
					>
				</h2>
				<ul
					class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
					data-testid="trash-items"
				>
					{#each data.trash.items as i (i.id)}
						<li
							class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
							data-row
						>
							<span
								class="w-40 shrink-0 font-mono text-xs leading-4 [overflow-wrap:anywhere] text-muted max-sm:hidden"
								>{i.ref}</span
							>
							<span class="min-w-0 flex-1 text-sm"
								><!-- ON A PHONE THE REFERENCE SITS ABOVE THE TITLE, SO THE ROW KEEPS ITS WIDTH FOR THE TITLE AND THE ACTIONS -->
								<span class="block font-mono text-xs [overflow-wrap:anywhere] text-muted sm:hidden"
									>{i.ref}</span
								>{i.title}
								<span class="block text-xs text-muted"
									>Removed {i.deletedAt ? ago(i.deletedAt) : ''}</span
								></span
							>
							{@render daysBadge(i.daysLeft)}
							<Button size="sm" onclick={() => restore(i.ref)} data-testid="restore">Restore</Button
							>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if data.trash.tasks.length}
			<section class="flex flex-col gap-2" aria-label="Tasks in the trash">
				<h2 class="text-lg font-semibold">Tasks</h2>
				<ul class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
					{#each data.trash.tasks as t (t.id)}
						<li
							class="flex items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0"
						>
							<span class="w-12 shrink-0 font-mono text-xs text-muted">T-{t.number}</span>
							<span class="min-w-0 flex-1 [overflow-wrap:anywhere]">{t.title}</span>
							{@render daysBadge(t.daysLeft)}
							<Button
								size="sm"
								onclick={() => restoreTask(t.id, t.number)}
								data-testid="restore-task">Restore</Button
							>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if data.trash.attachments.length}
			<section class="flex flex-col gap-2" aria-label="Files in the trash">
				<h2 class="text-lg font-semibold">Files</h2>
				<ul class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
					{#each data.trash.attachments as a (a.id)}
						<li
							class="flex items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0"
						>
							<span class="min-w-0 flex-1 truncate">{a.filename}</span>
							{@render daysBadge(a.daysLeft)}
							<Button size="sm" onclick={() => restoreFile(a.id, a.filename)}>Restore</Button>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</PageFrame>
