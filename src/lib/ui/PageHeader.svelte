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
<header class={cn('flex flex-wrap items-start justify-between gap-x-6 gap-y-3 pt-8 pb-6', extra)}>
	<div class="min-w-0 flex-1">
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
		<div class="flex flex-wrap items-center gap-2">{@render actions()}</div>
	{/if}
</header>
