<script lang="ts">
	// -- ENVS -- //
	import { page } from '$app/state';
	// -- MODULES -- //
	import Button from '#lib/ui/Button.svelte';
	import Illustration from '#lib/ui/Illustration.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';

	// -- REACTIVE STATES -- //

	const missing = $derived(page.status === 404);
</script>

<svelte:head><title>{missing ? 'Page not found' : 'Something went wrong'}</title></svelte:head>

<!-- THE ONE ERROR PAGE, WITH THE SAME FRAME AS EVERY OTHER SCREEN (ADR-012) -->
<PageFrame
	tag="main"
	class="flex min-h-dvh flex-col items-center justify-center gap-3 py-16 text-center"
>
	<Illustration kind={missing ? 'search' : 'error'} class="mb-2" />
	<p class="font-mono text-sm text-muted">{page.status}</p>
	<h1 class="text-xl font-semibold tracking-tight sm:text-2xl" data-testid="page-title">
		{missing ? 'This page does not exist' : 'Something went wrong'}
	</h1>
	<p class="max-w-[48ch] text-sm text-muted">
		{missing
			? 'The address may be wrong, or the item may have moved to the trash.'
			: 'The page could not be shown. Try again, and tell the owner if it keeps happening.'}
	</p>
	<div class="mt-3 flex flex-wrap justify-center gap-2">
		<Button variant="primary" href="/">Go to your organisations</Button>
	</div>
</PageFrame>
