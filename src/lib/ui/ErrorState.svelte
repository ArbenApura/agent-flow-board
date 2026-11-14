<script lang="ts">
	// IMPORTED MODULES
	import Button from '#lib/ui/Button.svelte';
	// IMPORTED DEP-COMPONENTS
	import CircleAlert from '@lucide/svelte/icons/circle-alert';

	// -- REQUIRED PROPS -- //

	let {
		title = 'That did not load',
		message,
		onretry
	}: {
		title?: string;
		/** What failed, in plain words. */
		message: string;
		/** Shows a retry button that stays busy until the promise settles. */
		onretry?: () => void | Promise<void>;
	} = $props();

	// -- STATES -- //

	let retrying = $state(false);

	// -- FUNCTIONS -- //

	async function retry() {
		retrying = true;
		try {
			await onretry?.();
		} finally {
			retrying = false;
		}
	}
</script>

<div class="flex flex-col items-center gap-2 px-4 py-10 text-center" role="alert">
	<CircleAlert size={24} class="text-danger" />
	<h2 class="text-base leading-6 font-semibold text-ink sm:text-lg sm:leading-[26px]">{title}</h2>
	<p class="max-w-[48ch] text-sm text-muted">{message}</p>
	{#if onretry}
		<div class="mt-2">
			<Button variant="primary" loading={retrying} onclick={retry}>Try again</Button>
		</div>
	{/if}
</div>
