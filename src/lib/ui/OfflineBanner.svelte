<script lang="ts">
	// -- DEP-MODULES -- //
	import { onMount } from 'svelte';
	// -- DEP-COMPONENTS -- //
	import WifiSlash from 'phosphor-svelte/lib/WifiSlash';

	// -- REQUIRED PROPS -- //

	let {
		liveLost = false,
		onreconnect
	}: {
		/** True when the live update stream dropped even though the network is up. */
		liveLost?: boolean;
		/** Called when the network returns, so the page refetches what it missed. */
		onreconnect?: () => void;
	} = $props();

	// -- STATES -- //

	let online = $state(true);

	// -- LIFECYCLES -- //

	onMount(() => {
		online = navigator.onLine;
		const up = () => {
			online = true;
			onreconnect?.();
		};
		const down = () => (online = false);
		addEventListener('online', up);
		addEventListener('offline', down);
		return () => {
			removeEventListener('online', up);
			removeEventListener('offline', down);
		};
	});
</script>

{#if !online || liveLost}
	<div
		role="status"
		class="flex min-h-11 items-center gap-2 border-b border-line bg-warning-soft px-4 py-2 text-sm text-warning"
	>
		<WifiSlash size={16} aria-hidden="true" />
		{#if !online}
			You are offline. Changes you make now will not be saved until the connection returns.
		{:else}
			Live updates paused. This page refetches when the connection returns.
		{/if}
	</div>
{/if}
