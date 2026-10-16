<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Select from '#lib/ui/Select.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- CONSTANTS -- //

	const STATES = ['TODO', 'IN PROGRESS', 'FUTURE', 'DONE', 'DROPPED'] as const;

	// -- STATES -- //

	let title = $state('');
	let error = $state('');
	let busy = $state(false);
	/** The status a change asked for, shown at once while the server answers. */
	let pending = $state<Record<string, string>>({});

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const canWrite = $derived(data.summary?.caps.includes('write') ?? false);
	const statusOf = (id: string, s: string) => pending[id] ?? s;

	// -- FUNCTIONS -- //

	async function add() {
		error = '';
		busy = true;
		try {
			await api(org, `/projects/${key}/tasks`, { body: { title: title.trim() }, key: newKey() });
			title = '';
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
			await api(org, `/tasks/${id}`, { method: 'PATCH', body: { status }, key: newKey() });
			await invalidate('afb:project');
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The task was not changed.');
		} finally {
			delete pending[id];
		}
	}
</script>

<svelte:head><title>Tasks, {data.summary?.project.name ?? ''}</title></svelte:head>

<div class="mx-auto flex max-w-[960px] flex-col gap-4 px-4 py-6 max-sm:px-3.5">
	<h1 class="text-xl leading-7 font-semibold sm:text-2xl sm:leading-8" data-testid="page-title">
		Tasks
	</h1>

	{#if canWrite}
		<form
			class="flex items-end gap-2"
			onsubmit={(e) => {
				e.preventDefault();
				void add();
			}}
		>
			<TextField
				label="Add a task"
				bind:value={title}
				{error}
				class="flex-1"
				minlength={3}
				required
				data-testid="new-task-title"
			/>
			<Button type="submit" variant="primary" loading={busy} data-testid="new-task-submit"
				>Add</Button
			>
		</form>
	{/if}

	{#if data.tasks.length === 0}
		<EmptyState
			title="No tasks yet"
			text="Tasks are small jobs outside any plan. Add one above, or link it to an item later."
		/>
	{:else}
		<ul class="rounded-xl border border-line bg-surface" data-testid="task-list">
			{#each data.tasks as t (t.id)}
				<li
					class="flex min-h-12 flex-wrap items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
					data-row
					data-testid="task"
				>
					<span class="w-12 shrink-0 font-mono text-xs text-muted">T-{t.number}</span>
					<span
						class="min-w-0 flex-1 text-sm {statusOf(t.id, t.status) === 'DONE'
							? 'text-muted line-through'
							: 'text-ink'}"
					>
						{t.title}
						{#each t.linkedItemIds as id (id)}
							{#if data.refs[id]}
								<a
									class="ml-1 font-mono text-xs text-accent-text hover:underline"
									href={`/${org}/${key}/${data.refs[id]}`}>{data.refs[id]}</a
								>
							{/if}
						{/each}
						{#if t.assigneeId && data.people[t.assigneeId]}
							<span class="ml-1 text-xs text-muted">{data.people[t.assigneeId]}</span>
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
						<details class="w-full text-xs leading-4 text-muted" data-testid="task-details">
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
</div>
