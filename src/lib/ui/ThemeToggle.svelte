<script lang="ts">
	// -- ENVS -- //
	import { onMount } from 'svelte';
	// -- MODULES -- //
	import { live, setLiveMode, syncLive } from '#lib/theme/live.svelte.js';
	import Button from '#lib/ui/Button.svelte';
	// -- DEP-COMPONENTS -- //
	import Moon from '@lucide/svelte/icons/moon';
	import Sun from '@lucide/svelte/icons/sun';

	// -- REACTIVE STATES -- //

	const dark = $derived(live.mode === 'dark');

	// -- LIFECYCLES -- //

	onMount(syncLive);
</script>

<!-- THE LIGHT AND DARK SWITCH OF THE TOP BAR. IT SHOWS THE MODE YOU WOULD SWITCH TO -->
<Button
	variant="ghost"
	iconOnly
	aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
	data-testid="theme-toggle"
	onclick={() => setLiveMode(dark ? 'light' : 'dark')}
>
	{#if dark}<Sun size={20} />{:else}<Moon size={20} />{/if}
</Button>
