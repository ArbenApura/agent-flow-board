<script lang="ts">
	// -- TYPES -- //
	import type { NoteListRow } from '#lib/board/notes/NoteRow.svelte';
	// -- MODULES -- //
	import { ago } from '#lib/board/status.js';
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import Lock from '@lucide/svelte/icons/lock';
	import Star from '@lucide/svelte/icons/star';
	// -- COMPONENTS -- //
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';

	// -- REQUIRED PROPS -- //

	let {
		note,
		href,
		onstar,
		folder = ''
	}: {
		note: NoteListRow;
		href: string;
		onstar: () => void;
		/** The folder's path; a note at the top shows none. */
		folder?: string;
	} = $props();
</script>

<!-- ONE NOTE AS A CARD, ON THE TaskCard PATTERN (AFB-20261111-0805). THE TITLE LINK COVERS THE CARD, THE STAR SITS ABOVE IT -->
<article
	data-card
	data-testid="note-card"
	class="group relative flex flex-col gap-2 overflow-hidden rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)] transition-colors hover:border-muted motion-reduce:transition-none max-sm:p-3.5"
>
	<div class="flex min-h-6 min-w-0 items-center gap-2 text-xs text-muted">
		<span class="shrink-0 font-mono">{note.ref}</span>
		{#if folder}
			<span class="min-w-0 truncate rounded-md bg-raised px-1.5 leading-5 font-medium"
				>{folder}</span
			>
		{/if}
		{#if note.private}
			<Badge class="shrink-0"><Lock size={12} /> Private</Badge>
		{/if}
		<span class="-my-2 -mr-2 ml-auto flex shrink-0">
			<button
				type="button"
				aria-label={note.favourite ? `Remove the star from ${note.title}` : `Star ${note.title}`}
				aria-pressed={note.favourite}
				onclick={onstar}
				class="relative z-10 inline-flex size-10 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent max-md:size-11"
			>
				<Star size={18} class={cn(note.favourite && 'fill-current text-warning')} />
			</button>
		</span>
	</div>
	<a
		{href}
		class="line-clamp-2 cursor-pointer text-sm leading-6 font-semibold [overflow-wrap:anywhere] text-ink group-hover:underline before:absolute before:inset-0 focus-visible:outline-none focus-visible:before:rounded-xl focus-visible:before:outline-2 focus-visible:before:-outline-offset-2 focus-visible:before:outline-accent"
		>{note.title}</a
	>
	{#if note.excerpt}
		<!-- PLAIN TEXT ONLY, NEVER RENDERED AS MARKDOWN OR HTML -->
		<p class="line-clamp-4 text-xs leading-5 [overflow-wrap:anywhere] text-muted">{note.excerpt}</p>
	{/if}
	<div class="mt-auto flex min-w-0 items-center gap-2 border-t border-line pt-3 text-xs text-muted">
		{#if note.lastEditor}
			<Avatar name={note.lastEditor.name} userId={note.lastEditor.id} size={24} />
			<span class="truncate">{note.lastEditor.name}</span>
			<span aria-hidden="true">·</span>
		{/if}
		<span class="shrink-0 tabular-nums">{ago(note.updatedAt)}</span>
	</div>
</article>
