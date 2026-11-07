<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	import type { ScreenKey } from '#lib/board/mockups.js';
	// -- ENVS -- //
	import { page } from '$app/state';
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
	// -- MODULES -- //
	import { screensOf } from '#lib/board/mockups.js';
	import MockupPreview from '#lib/board/MockupPreview.svelte';
	import Logo from '#lib/ui/Logo.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import ThemeToggle from '#lib/ui/ThemeToggle.svelte';
	// -- DEP-COMPONENTS -- //
	import Link2Off from '@lucide/svelte/icons/link-2-off';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- STATES -- //

	let screen = $state<ScreenKey>('laptop');

	// -- REACTIVE STATES -- //

	const screens = $derived(data.available ? screensOf(data.screens) : []);
	// The file is served by its own route, sandboxed, and never carries the pin script
	const src = $derived(`/m/${page.params.token}/file`);

	// -- REACTIVE STATEMENTS -- //

	$effect(() => {
		const offered = screens;
		untrack(() => {
			if (offered.length && !offered.includes(screen))
				screen = offered.includes('laptop') ? 'laptop' : offered[0];
		});
	});
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
				<!-- ONE PLAIN PAGE FOR A WRONG ADDRESS, A LINK THAT IS OFF, A TRASHED MOCKUP AND A PRIVATE PLAN -->
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
						Shared by {data.sharedBy}{data.projectName
							? ` from ${data.projectName}`
							: ''}{data.planRef ? `, for ${data.planRef}` : ''}. Version {data.version}.
					</p>
				</div>
				<Notice tone="info" data-testid="public-notice">
					This is a design idea, not the finished product. It runs in a sandbox, so it cannot reach
					your accounts, and you can only look.
				</Notice>
				<div
					class="rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)] max-sm:p-3.5"
				>
					<MockupPreview {src} {screens} title={data.title} bind:screen />
				</div>
			{/if}
		</PageFrame>
	</main>

	<footer class="border-t border-line py-4 text-center text-xs text-muted">
		Made with Agent Flow Board
	</footer>
</div>
