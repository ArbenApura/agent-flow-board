<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- MODULES -- //
	import Mark from '#lib/ui/Mark.svelte';

	// -- REQUIRED PROPS -- //

	let {
		title,
		subtitle,
		children,
		footer
	}: {
		title: string;
		subtitle?: string;
		children: Snippet;
		/** A line under the card, for the link to the other page. */
		footer?: Snippet;
	} = $props();
</script>

<!-- THE SHARED FRAME OF EVERY SIGN IN PAGE: WORDMARK, ONE CARD, ONE LINE UNDER IT -->
<main class="flex min-h-dvh flex-col items-center justify-center px-4 py-8">
	<div class="flex w-full max-w-[400px] flex-col gap-5">
		<div class="flex items-center gap-2 font-bold">
			<Mark size={24} />
			<span>agent-flow-board</span>
		</div>
		<div class="rounded-xl border border-line bg-surface p-6 max-sm:p-5">
			<h1 class="text-xl leading-7 font-semibold sm:text-2xl sm:leading-8">{title}</h1>
			{#if subtitle}<p class="mt-1 mb-4 text-sm leading-[22px] text-muted">{subtitle}</p>{:else}<div
					class="mb-4"
				></div>{/if}
			{@render children()}
		</div>
		{#if footer}<p class="text-sm leading-[22px] text-muted">{@render footer()}</p>{/if}
	</div>
</main>
