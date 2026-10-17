<script lang="ts">
	// -- ASSETS -- //
	import '../app.css';
	// -- DEP-TYPES -- //
	import type { LayoutProps } from './$types';
	// -- ENVS -- //
	import { browser } from '$app/env';
	import { invalidateAll } from '$app/navigation';
	import { navigating, page } from '$app/state';
	import { onMount } from 'svelte';
	// -- MODULES -- //
	import { installSwr } from '#lib/board/swr.js';
	import { styleFor } from '#lib/theme/css.js';
	// -- COMPONENTS -- //
	import ConfirmHost from '#lib/ui/ConfirmHost.svelte';
	import Toaster from '#lib/ui/Toaster.svelte';

	// -- REQUIRED PROPS -- //

	let { children }: LayoutProps = $props();

	// -- REACTIVE STATES -- //

	// The accent colour comes from the organisation only. A person chooses light or dark, never a colour
	const css = $derived(styleFor(page.data.orgPalette));

	// -- FUNCTIONS -- //

	if (browser) installSwr(() => void invalidateAll());

	// -- LIFECYCLES -- //

	onMount(() => {
		// The app is mounted, so the boot skeleton and the cached palette give way to the real ones
		document.getElementById('afb-boot')?.remove();
		document.getElementById('afb-palette-boot')?.remove();
		document.documentElement.removeAttribute('data-boot');
	});

	// The next visit paints this organisation's palette from the first frame
	$effect(() => {
		try {
			localStorage.setItem(`afb-palette:${page.params.org ?? ''}`, css);
		} catch {
			/* Storage can be blocked */
		}
	});
</script>

<svelte:head>
	{#if css}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- the rules are built from six digit colours the palette generator made -->
		{@html `<style id="afb-palette">${css}</style>`}
	{/if}
</svelte:head>

<!-- A THIN PROGRESS BAR AT THE TOP WHILE ANOTHER PAGE LOADS, SO A CLICK ANSWERS AT ONCE -->
{#if navigating.to}
	<div
		class="fixed inset-x-0 top-0 z-[5000] h-0.5 origin-left animate-[afb-progress_1.2s_ease-out_forwards] bg-accent"
		role="progressbar"
		aria-label="Loading"
		data-testid="nav-progress"
	></div>
{/if}
{@render children()}

<Toaster />
<ConfirmHost />
