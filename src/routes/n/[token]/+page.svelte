<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- MODULES -- //
	import Logo from '#lib/ui/Logo.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import ThemeToggle from '#lib/ui/ThemeToggle.svelte';
	// -- DEP-COMPONENTS -- //
	import Link2Off from '@lucide/svelte/icons/link-2-off';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.available ? data.title : 'Link not available'}</title>
	<meta name="robots" content="noindex, nofollow" />
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="flex min-h-dvh flex-col">
	<!-- THE TOP BAR OF A PUBLIC PAGE: THE LOGO LOCKUP AND THE LIGHT AND DARK SWITCH, NOTHING ELSE -->
	<header class="border-b border-line bg-bar backdrop-blur-md">
		<PageFrame testid="public-bar">
			<div class="flex h-14 items-center justify-between gap-3 md:h-16">
				<Logo size={28} />
				<ThemeToggle />
			</div>
		</PageFrame>
	</header>

	<main class="flex-1">
		<PageFrame class="flex flex-col gap-4 py-6 pb-12">
			{#if !data.available}
				<!-- ONE PLAIN PAGE FOR A WRONG ADDRESS, A LINK THAT IS OFF, A TRASHED NOTE AND A PRIVATE NOTE -->
				<div
					class="mx-auto flex max-w-md flex-col items-center gap-3 rounded-xl border border-line bg-surface p-8 text-center shadow-[var(--elev-1)]"
					data-testid="public-unavailable"
				>
					<Link2Off size={24} class="text-muted" aria-hidden="true" />
					<h1 class="text-lg font-semibold text-ink">This link is no longer available</h1>
					<p class="text-sm text-muted">The person who shared it may have switched it off.</p>
				</div>
			{:else}
				<div class="flex flex-col gap-1" data-testid="public-header">
					<h1 class="text-xl font-semibold tracking-tight text-ink sm:text-2xl">{data.title}</h1>
					<p class="text-sm text-muted">
						Shared by {data.sharedBy}{data.projectName ? ` from ${data.projectName}` : ''}. You can
						only look.
					</p>
				</div>
				<article
					class="rounded-xl border border-line bg-surface p-5 shadow-[var(--elev-1)] max-sm:p-4"
					data-testid="public-note-body"
				>
					{#if data.empty}
						<p class="text-sm text-muted">This note has no text yet.</p>
					{:else}
						<!-- THE BODY IS MARKDOWN, SANITISED ON THE SERVER, WITH NO LINKS INTO THE BOARD -->
						<div class="md flex flex-col gap-2 text-sm text-ink">
							<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown from the server -->
							{@html data.html}
						</div>
					{/if}
				</article>
			{/if}
		</PageFrame>
	</main>

	<footer class="border-t border-line py-4 text-center text-xs text-muted">
		Made with Agent Flow Board
	</footer>
</div>
