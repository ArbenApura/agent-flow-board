<script lang="ts">
	// -- TYPES -- //
	import type { TaskRow } from '#lib/board/tasks.js';
	// -- MODULES -- //
	import { draggable } from '#lib/actions/dnd.svelte.js';
	import { TASK_STATUS_STYLE, asTaskState, bodyPreview } from '#lib/board/tasks.js';
	import { cn } from '#lib/ui/cn.js';
	import Avatar from '#lib/ui/Avatar.svelte';

	// -- REQUIRED PROPS -- //

	let {
		task,
		refs,
		assignee,
		assigneeV,
		hrefFor,
		onopen,
		dragEnabled = false,
		showStatus = false
	}: {
		task: TaskRow;
		/** The reference of every item a task can link, by item id. */
		refs: Record<string, string>;
		/** The name of the person the task is assigned to, when there is one. */
		assignee?: string;
		/** The version of the assignee's avatar, when they have one. */
		assigneeV?: number | null;
		hrefFor: (ref: string) => string;
		onopen: (id: string) => void;
		/** A board card can be dragged to another status column. */
		dragEnabled?: boolean;
		/** Groups and list views have no column, so the card names its status itself. */
		showStatus?: boolean;
	} = $props();

	// -- REACTIVE STATES -- //

	const state = $derived(asTaskState(task.status));
	const preview = $derived(bodyPreview(task.body));
	const linked = $derived(task.linkedItemIds.filter((id) => refs[id]));
</script>

<!-- ONE TASK AS A BOARD CARD. THE BUTTON OPENS THE DRAWER, THE LINKS SIT BESIDE IT SO A CLICK ON THEM NEVER OPENS THE TASK -->
<article
	use:draggable={{ id: task.id, disabled: !dragEnabled }}
	data-testid="task"
	data-card
	class="relative flex flex-col gap-2 overflow-hidden rounded-xl border border-line bg-surface py-3.5 pr-3.5 pl-4.5 transition-colors hover:border-muted"
>
	<!-- STATUS RAIL -->
	<span
		class={cn('absolute inset-y-0 left-0 w-[3px]', TASK_STATUS_STYLE[state].rail)}
		aria-hidden="true"
	></span>
	<button
		type="button"
		onclick={() => onopen(task.id)}
		data-testid="task-open"
		class="flex min-h-11 w-full cursor-pointer flex-col gap-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
	>
		<span class="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
			<span class="font-mono">T-{task.number}</span>
			{#if task.priority?.trim()}
				<span class="rounded-md bg-raised px-1.5 text-badge font-semibold text-ink"
					>{task.priority.trim()}</span
				>
			{/if}
			{#if showStatus}
				<span class="ml-auto inline-flex items-center gap-1.5 font-medium text-ink">
					<span class={cn('size-2 rounded-full', TASK_STATUS_STYLE[state].dot)} aria-hidden="true"
					></span>
					{state.toLowerCase()}
				</span>
			{/if}
		</span>
		<span
			class={cn(
				'line-clamp-2 text-sm leading-6 font-semibold [overflow-wrap:anywhere]',
				state === 'DONE' || state === 'DROPPED' ? 'text-muted' : 'text-ink'
			)}>{task.title}</span
		>
		{#if preview}
			<!-- PLAIN TEXT ONLY, NEVER RENDERED AS MARKDOWN OR HTML -->
			<span class="line-clamp-2 text-xs leading-5 [overflow-wrap:anywhere] text-muted"
				>{preview}</span
			>
		{/if}
	</button>
	{#if task.groupName || linked.length || assignee}
		<span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
			{#if task.groupName}
				<span class="max-w-full truncate rounded-md bg-raised px-1.5 font-medium"
					>{task.groupName}</span
				>
			{/if}
			{#each linked as id (id)}
				<a
					class="cursor-pointer font-mono text-accent-text hover:underline focus-visible:outline-2"
					href={hrefFor(refs[id])}
					draggable="false">{refs[id]}</a
				>
			{/each}
			{#if assignee}
				<span class="ml-auto"
					><Avatar name={assignee} userId={task.assigneeId} v={assigneeV} size={24} /></span
				>
			{/if}
		</span>
	{/if}
</article>
