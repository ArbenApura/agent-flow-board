<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		title,
		context,
		actions,
		back,
		testid = 'page-title',
		class: extra
	}: {
		title: string;
		/** One line saying what the page is, or a snippet when it needs markup. */
		context?: string | Snippet;
		/** The actions of the page, on the right. One primary at most. */
		actions?: Snippet;
		back?: { href: string; label: string };
		testid?: string;
		class?: string;
	} = $props();
</script>

<!-- ONE PAGE HEADER FOR EVERY SCREEN. TITLE, ONE LINE OF CONTEXT, ACTIONS ON THE RIGHT -->
<header
	class={cn(
		'enter relative mt-6 mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3 overflow-hidden rounded-2xl border border-line bg-band px-6 py-5 shadow-[var(--elev-1)] max-sm:px-4',
		extra
	)}
>
	<!-- A QUIET GRAPHIC OF ARCS IN THE ACCENT, THE SAME ON EVERY SCREEN SO THE BAND READS AS ONE FAMILY -->
	<svg
		viewBox="0 0 240 120"
		class="pointer-events-none absolute -top-6 -right-8 h-40 w-80 text-accent opacity-[0.14] max-sm:hidden"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		aria-hidden="true"
	>
		<circle cx="200" cy="40" r="30" />
		<circle cx="200" cy="40" r="55" />
		<circle cx="200" cy="40" r="80" />
		<circle cx="200" cy="40" r="105" />
	</svg>
	<div class="relative min-w-0 flex-1">
		{#if back}
			<a href={back.href} class="mb-1 inline-block text-sm text-accent-text hover:underline"
				>{back.label}</a
			>
		{/if}
		<h1 class="text-xl font-semibold tracking-tight text-ink sm:text-2xl" data-testid={testid}>
			{title}
		</h1>
		{#if typeof context === 'string'}
			<p class="mt-1 text-sm text-muted">{context}</p>
		{:else if context}
			<div class="mt-1 text-sm text-muted">{@render context()}</div>
		{/if}
	</div>
	{#if actions}
		<div class="relative flex flex-wrap items-center gap-2">{@render actions()}</div>
	{/if}
</header>
