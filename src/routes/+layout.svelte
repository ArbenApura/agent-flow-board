<script lang="ts">
	// -- ASSETS -- //
	import '../app.css';
	// -- DEP-TYPES -- //
	import type { LayoutProps } from './$types';
	// -- ENVS -- //
	import { page } from '$app/state';
	// -- MODULES -- //
	import { styleFor } from '#lib/theme/css.js';
	// -- COMPONENTS -- //
	import ConfirmHost from '#lib/ui/ConfirmHost.svelte';
	import Toaster from '#lib/ui/Toaster.svelte';

	// -- REQUIRED PROPS -- //

	let { data, children }: LayoutProps = $props();

	// -- REACTIVE STATES -- //

	// The org palette first, then the person's own accent over it, so a personal choice wins
	const css = $derived(styleFor(page.data.orgPalette, data.personalPalette));
</script>

<svelte:head>
	{#if css}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- the rules are built from six digit colours the palette generator made -->
		{@html `<style id="afb-palette">${css}</style>`}
	{/if}
</svelte:head>

{@render children()}

<Toaster />
<ConfirmHost />
