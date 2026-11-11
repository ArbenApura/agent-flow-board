<script lang="ts" module>
	// -- TYPES -- //

	/** One note as the Notes page lists it: plain text only, never HTML (AFB-20261111-0805). */
	export type NoteListRow = {
		id: string;
		ref: string;
		title: string;
		folderId: string | null;
		private: boolean;
		favourite: boolean;
		excerpt: string;
		match: { text: string; marks: [number, number][] } | null;
		lastEditor: { id: string; name: string } | null;
		updatedAt: Date | string;
	};
</script>

<script lang="ts">
	// -- TYPES -- //
	import type { MenuItem } from '#lib/ui/ActionMenu.svelte';
	// -- MODULES -- //
	import { markedParts } from '#lib/board/notes/view.js';
	import { ago } from '#lib/board/status.js';
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import FileText from '@lucide/svelte/icons/file-text';
	import Lock from '@lucide/svelte/icons/lock';
	import Star from '@lucide/svelte/icons/star';
	// -- COMPONENTS -- //
	import ActionMenu from '#lib/ui/ActionMenu.svelte';
	import Badge from '#lib/ui/Badge.svelte';

	// -- REQUIRED PROPS -- //

	let {
		note,
		href,
		menu,
		onstar,
		folder = '',
		draggable = false,
		ondragstart
	}: {
		note: NoteListRow;
		href: string;
		menu: MenuItem[];
		onstar: () => void;
		/** The folder's path, shown in a view that holds more than one folder. */
		folder?: string;
		draggable?: boolean;
		ondragstart?: (e: DragEvent) => void;
	} = $props();

	// -- CONSTANTS -- //

	// Shown on hover or keyboard focus with a mouse; always shown on a touch screen
	const REVEAL =
		'pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100';

	// -- REACTIVE STATES -- //

	const parts = $derived(note.match ? markedParts(note.match.text, note.match.marks) : null);
	const changed = $derived(ago(note.updatedAt));
	const meta = $derived([folder, changed].filter(Boolean).join(' · '));
</script>

<!-- ONE NOTE AS A LIST ROW. THE WHOLE ROW OPENS THE NOTE; THE STAR AND THE MENU SIT ABOVE THE LINK -->
<li
	class="group relative flex items-center gap-3 border-b border-line px-4 py-3 transition-colors last:border-b-0 hover:bg-raised/40 motion-reduce:transition-none max-sm:gap-2 max-sm:px-3.5"
	data-row
	data-testid="note"
	{draggable}
	{ondragstart}
>
	<span
		class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted max-sm:hidden"
		aria-hidden="true"><FileText size={18} /></span
	>
	<a
		{href}
		class="flex min-h-11 min-w-0 flex-1 cursor-pointer flex-col justify-center gap-0.5 before:absolute before:inset-0 focus-visible:outline-none focus-visible:before:outline-2 focus-visible:before:-outline-offset-2 focus-visible:before:outline-accent"
	>
		<span class="flex min-w-0 items-center gap-2">
			<span
				class="truncate text-sm font-semibold text-ink group-hover:underline max-sm:line-clamp-2 max-sm:whitespace-normal"
				>{note.title}</span
			>
			<span class="shrink-0 font-mono text-xs text-muted">{note.ref}</span>
			{#if note.private}
				<Badge class="shrink-0"><Lock size={12} /> Private</Badge>
			{/if}
		</span>
		{#if parts}
			<!-- A SEARCH: THE WORDS AROUND THE HIT, THE MATCHES MARKED. PLAIN TEXT PARTS, NEVER HTML -->
			<span class="line-clamp-2 text-xs leading-5 text-muted">
				{#each parts as p, i (i)}{#if p.mark}<mark
							class="rounded-sm bg-accent-soft px-0.5 text-accent-text">{p.text}</mark
						>{:else}{p.text}{/if}{/each}
			</span>
		{:else if note.excerpt}
			<span class="line-clamp-1 text-xs leading-5 text-muted max-sm:line-clamp-2"
				>{note.excerpt}</span
			>
		{/if}
		<span class="truncate text-xs leading-5 text-muted lg:hidden">{meta}</span>
	</a>
	{#if folder}
		<span class="w-48 shrink-0 max-lg:hidden">
			<span
				class="inline-block max-w-full truncate rounded-md bg-raised px-1.5 text-xs leading-5 font-medium text-muted"
				>{folder}</span
			>
		</span>
	{/if}
	<span class="w-20 shrink-0 text-right text-xs text-muted tabular-nums max-lg:hidden"
		>{changed}</span
	>
	<button
		type="button"
		aria-label={note.favourite ? `Remove the star from ${note.title}` : `Star ${note.title}`}
		aria-pressed={note.favourite}
		onclick={onstar}
		class={cn(
			'relative z-10 inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-opacity hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none max-md:size-11',
			!note.favourite && [REVEAL, 'max-sm:hidden']
		)}
	>
		<Star size={18} class={cn(note.favourite && 'fill-current text-warning')} />
	</button>
	{#if menu.length}
		<span class={cn('relative z-10 shrink-0 max-sm:hidden', REVEAL)}>
			<ActionMenu items={menu} label={`Actions for ${note.title}`} size="sm" />
		</span>
	{/if}
</li>
