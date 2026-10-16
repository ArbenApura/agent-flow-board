<script lang="ts">
	// -- DEP-TYPES -- //
	import type { LayoutProps } from './$types';
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import { connectStream } from '#lib/realtime/stream.svelte.js';
	import OfflineBanner from '#lib/ui/OfflineBanner.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';

	// -- REQUIRED PROPS -- //

	let { data, children }: LayoutProps = $props();

	// -- STATES -- //

	const live = $state({ lost: false });

	// -- FUNCTIONS -- //

	const refetch = () => invalidate('afb:project');

	// -- EFFECTS -- //

	// Plain values, so a refetch (a new `data` object) does not close and reopen the stream
	const denied = $derived(Boolean(data.denied));
	const streamUrl = $derived(`/${page.params.org}/${page.params.project}/stream`);

	// One stream per open project. It closes when the person leaves the project.
	$effect(() => {
		if (denied) return;
		return connectStream(streamUrl, live, refetch);
	});
</script>

<OfflineBanner liveLost={live.lost} onreconnect={refetch} />

{#if data.denied}
	<div class="mx-auto max-w-[720px] px-4 py-6 max-sm:px-3.5">
		<PermissionDenied needed={data.denied.needed} current={data.denied.role} what="this project" />
	</div>
{:else}
	{@render children()}
{/if}
