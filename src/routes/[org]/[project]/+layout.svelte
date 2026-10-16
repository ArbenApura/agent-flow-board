<script lang="ts">
	// -- DEP-TYPES -- //
	import type { LayoutProps } from './$types';
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import { clearCache } from '#lib/board/swr.js';
	import { connectStream } from '#lib/realtime/stream.svelte.js';
	import OfflineBanner from '#lib/ui/OfflineBanner.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';

	// -- REQUIRED PROPS -- //

	let { data, children }: LayoutProps = $props();

	// -- STATES -- //

	const live = $state({ lost: false });

	// -- FUNCTIONS -- //

	// A change the live hub announced must come from the network, so the cache is cleared first
	const refetch = (announced = true) => {
		if (announced) clearCache();
		return invalidate('afb:project');
	};

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

<OfflineBanner liveLost={live.lost} onreconnect={() => refetch()} />

{#if data.denied}
	<PageFrame class="flex flex-col gap-5 py-8 pb-12">
		<PermissionDenied needed={data.denied.needed} current={data.denied.role} what="this project" />
	</PageFrame>
{:else}
	{@render children()}
{/if}
