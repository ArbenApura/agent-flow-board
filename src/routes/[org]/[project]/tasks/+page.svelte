<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import Avatar from '#lib/ui/Avatar.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Select from '#lib/ui/Select.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Plus from '@lucide/svelte/icons/plus';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- CONSTANTS -- //

	const STATES = ['TODO', 'IN PROGRESS', 'FUTURE', 'DONE', 'DROPPED'] as const;

	// -- STATES -- //

	let title = $state('');
	let error = $state('');
	let busy = $state(false);
	let adding = $state(false);
	/** The task whose detail drawer is open. */
	let openId = $state<string | null>(null);
	/** The status a change asked for, shown at once while the server answers. */
	let pending = $state<Record<string, string>>({});

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const canWrite = $derived(data.summary?.caps.includes('write') ?? false);
	const statusOf = (id: string, s: string) => pending[id] ?? s;
	const current = $derived(data.tasks.find((t) => t.id === openId) ?? null);

	// -- FUNCTIONS -- //

	async function add() {
		error = '';
		busy = true;
		try {
			// The text is fixed: a toast never carries what the person typed
			await toast.promise(
				api(org, `/projects/${key}/tasks`, { body: { title: title.trim() }, key: newKey() }),
				{
					id: 'task-add',
					loading: 'Adding the task...',
					success: 'Task added.',
					error: (e) => (e instanceof ApiError ? e.message : 'The task was not added.')
				}
			);
			title = '';
			adding = false;
			await invalidate('afb:project');
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'The task was not added.';
		} finally {
			busy = false;
		}
	}

	async function setStatus(id: string, status: string) {
		pending[id] = status;
		try {
			await toast.promise(
				api(org, `/tasks/${id}`, { method: 'PATCH', body: { status }, key: newKey() }),
				{
					loading: 'Updating the task...',
					success: 'Task updated.',
					error: (e) => (e instanceof ApiError ? e.message : 'The task was not changed.')
				}
			);
			await invalidate('afb:project');
		} catch {
			// The promise toast already shows the failure
		} finally {
			delete pending[id];
		}
	}
</script>

<svelte:head><title>Tasks, {data.summary?.project.name ?? ''}</title></svelte:head>

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader
		class="mb-2!"
		title="Tasks"
		context={`${data.tasks.length} ${data.tasks.length === 1 ? 'task' : 'tasks'}, small jobs outside any plan.`}
	>
		{#snippet actions()}
			{#if canWrite}
				<Button variant="primary" onclick={() => (adding = true)} data-testid="new-task">
					<Plus size={16} /> New task
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if data.tasks.length === 0}
		<EmptyState
			kind="inbox"
			title="No tasks yet"
			text="Tasks are small jobs outside any plan. Add one, or link it to an item later."
		/>
	{:else}
		<ul
			class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
			data-testid="task-list"
		>
			{#each data.tasks as t (t.id)}
				<li
					class="flex min-h-14 flex-wrap items-center gap-4 border-b border-line px-4 py-3 last:border-b-0"
					data-row
					data-testid="task"
				>
					<span class="w-12 shrink-0 font-mono text-xs text-muted">T-{t.number}</span>
					<span
						class="min-w-0 flex-1 text-sm {statusOf(t.id, t.status) === 'DONE'
							? 'text-muted line-through'
							: 'text-ink'}"
					>
						<button
							type="button"
							class="cursor-pointer text-left hover:underline focus-visible:outline-2"
							onclick={() => (openId = t.id)}
							data-testid="task-open">{t.title}</button
						>
						{#each t.linkedItemIds as id (id)}
							{#if data.refs[id]}
								<a
									class="ml-1 font-mono text-xs text-accent-text hover:underline"
									href={`/${org}/${key}/${data.refs[id]}`}>{data.refs[id]}</a
								>
							{/if}
						{/each}
						{#if t.assigneeId && data.people[t.assigneeId]}
							<span class="ml-2 inline-flex items-center gap-1.5 align-middle text-xs text-muted"
								><Avatar name={data.people[t.assigneeId]} size={24} />{data.people[
									t.assigneeId
								]}</span
							>
						{/if}
					</span>
					<Select
						label={`Status of T-${t.number}`}
						value={statusOf(t.id, t.status)}
						disabled={!canWrite}
						options={STATES.map((s) => ({ value: s, label: s.toLowerCase() }))}
						onchange={(v) => setStatus(t.id, v)}
						class="w-40"
					/>
					{#if t.body}
						<details class="w-full text-xs text-muted" data-testid="task-details">
							<summary class="cursor-pointer">
								Details{t.groupName ? `, ${t.groupName}` : ''}{t.priority
									? `, priority ${t.priority}`
									: ''}
							</summary>
							<div class="mt-1 whitespace-pre-wrap">{t.body}</div>
						</details>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</PageFrame>

<ResponsiveModal
	open={current !== null}
	onclose={() => (openId = null)}
	title={current ? `T-${current.number} ${current.title}` : 'Task'}
	variant="drawer"
	size="lg"
>
	{#if current}
		<div class="flex flex-col gap-4" data-testid="task-drawer">
			<Select
				label="Status"
				value={statusOf(current.id, current.status)}
				disabled={!canWrite}
				options={STATES.map((s) => ({ value: s, label: s.toLowerCase() }))}
				onchange={(v) => setStatus(current.id, v)}
			/>
			<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
				{#if current.assigneeId && data.people[current.assigneeId]}
					<dt class="text-muted">Assigned to</dt>
					<dd class="inline-flex items-center gap-2 text-ink">
						<Avatar name={data.people[current.assigneeId]} size={24} />{data.people[
							current.assigneeId
						]}
					</dd>
				{/if}
				{#if current.groupName}
					<dt class="text-muted">Group</dt>
					<dd class="text-ink">{current.groupName}</dd>
				{/if}
				{#if current.priority}
					<dt class="text-muted">Priority</dt>
					<dd class="text-ink">{current.priority}</dd>
				{/if}
				{#if current.linkedItemIds.length}
					<dt class="text-muted">Linked items</dt>
					<dd class="flex flex-wrap gap-2">
						{#each current.linkedItemIds as id (id)}
							{#if data.refs[id]}
								<a
									class="font-mono text-xs text-accent-text hover:underline"
									href={`/${org}/${key}/${data.refs[id]}`}>{data.refs[id]}</a
								>
							{/if}
						{/each}
					</dd>
				{/if}
			</dl>
			{#if current.body}
				<div class="text-sm whitespace-pre-wrap text-ink" data-testid="task-body">
					{current.body}
				</div>
			{:else}
				<p class="text-sm text-muted">This task has no description.</p>
			{/if}
		</div>
	{/if}
</ResponsiveModal>

<ResponsiveModal open={adding} onclose={() => (adding = false)} title="New task" size="sm" {busy}>
	<form
		class="flex flex-col gap-4"
		onsubmit={(e) => {
			e.preventDefault();
			void add();
		}}
	>
		<TextField
			label="What is the task"
			bind:value={title}
			{error}
			minlength={3}
			required
			data-testid="new-task-title"
		/>
		<div class="flex justify-end gap-2">
			<Button onclick={() => (adding = false)} disabled={busy}>Cancel</Button>
			<Button type="submit" variant="primary" loading={busy} data-testid="new-task-submit"
				>Add task</Button
			>
		</div>
	</form>
</ResponsiveModal>
