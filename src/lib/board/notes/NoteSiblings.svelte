<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Lock from '@lucide/svelte/icons/lock';
	import NotebookText from '@lucide/svelte/icons/notebook-text';

	// -- REQUIRED PROPS -- //

	let {
		folder,
		notes,
		current,
		base,
		allHref,
		count
	}: {
		/** How many notes the folder holds, when the list shows only the newest of them. */
		count?: number;
		/** The name of the folder the note sits in, or null for the notes at the top. */
		folder: string | null;
		notes: { id: string; ref: string; title: string; private: boolean }[];
		/** The reference of the open note. */
		current: string;
		/** The project's address, for the links to the notes. */
		base: string;
		allHref: string;
	} = $props();
</script>

<!-- IN THIS FOLDER: THE NOTES BESIDE THE OPEN ONE, FROM 2xl UP (AFB-20261111-0805). THE ROWS COPY THE TREE ROWS OF THE NOTES PAGE -->
<nav
	aria-label="In this folder"
	class="sticky top-[73px] hidden max-h-[calc(100dvh-89px)] overflow-y-auto rounded-xl border border-line bg-surface p-2 shadow-[var(--elev-1)] 2xl:block"
	data-testid="note-siblings"
>
	<div class="flex min-h-10 items-center gap-2 px-3 text-xs font-medium text-muted">
		<FolderOpen size={16} class="shrink-0" />
		<span class="min-w-0 flex-1 truncate">{folder ?? 'In no folder'}</span>
		<span class="tabular-nums">{count ?? notes.length}</span>
	</div>
	<ul class="flex flex-col gap-0.5">
		{#each notes as n (n.id)}
			{@const on = n.ref === current}
			<li>
				<a
					href={`${base}/notes/${n.ref}`}
					aria-current={on ? 'page' : undefined}
					class={cn(
						'flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm break-words hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
						on
							? 'bg-accent-soft font-medium text-accent-text hover:bg-accent-soft hover:text-accent-text'
							: 'text-muted'
					)}
				>
					<span class="min-w-0 flex-1">{n.title}</span>
					{#if n.private}<Lock size={12} class="shrink-0" aria-label="Private" />{/if}
				</a>
			</li>
		{/each}
	</ul>
	<div class="mx-1 my-2 border-t border-line"></div>
	<a
		href={allHref}
		class="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-3 text-sm text-accent-text hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
	>
		<NotebookText size={16} class="shrink-0" /> All notes
	</a>
</nav>
