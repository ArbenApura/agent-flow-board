<script lang="ts">
	// IMPORTED TYPES
	import type { QaMapFeature } from '#lib/board/qa/status.js';
	// IMPORTED MODULES
	import { QA_STATUS_RAIL, qaPlural, qaStatusOf } from '#lib/board/qa/status.js';
	import { ago } from '#lib/board/status.js';
	// IMPORTED COMPONENTS
	import QaStatusPill from '#lib/board/qa/QaStatusPill.svelte';
	import Badge from '#lib/ui/Badge.svelte';

	// -- REQUIRED PROPS -- //

	let {
		feature,
		href,
		depth = 0
	}: {
		feature: QaMapFeature;
		/** The feature page. */
		href: string;
		/** How many groups deep the row sits, 0 for a top group. */
		depth?: number;
	} = $props();

	// -- CONSTANTS -- //

	// A middle dot with a space each side. Written as a constant because Svelte trims the space next to an if block
	const SEP = ' · ';

	// -- REACTIVE STATES -- //

	const st = $derived(qaStatusOf(feature.status));
</script>

<!-- THE WHOLE ROW IS ONE LINK, SO HOVER AND FOCUS TINT ALL OF IT. THERE IS NO ACTION BUTTON IN A ROW: RETESTING IS ON THE GROUP AND THE FEATURE PAGE -->
<li class="relative border-b border-line last:border-b-0" data-testid="qa-feature">
	<!-- THE STATUS RAIL ON THE LEFT EDGE, A FIXED STATUS TOKEN -->
	<span class="absolute inset-y-0 left-0 w-[3px] {QA_STATUS_RAIL[st]}" aria-hidden="true"></span>
	<!-- THE INDENT IS 16 PX PER GROUP LEVEL, A RUNTIME VALUE -->
	<a
		{href}
		title={feature.name}
		data-qa-nav
		style="padding-left:{20 + depth * 16}px"
		class="flex min-h-14 min-w-0 cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 py-3 pr-4 hover:bg-raised/60 focus-visible:bg-raised/60 focus-visible:outline-2 focus-visible:outline-accent max-sm:pr-3 sm:flex-nowrap"
	>
		<span class="flex min-w-0 flex-1 basis-64 flex-col gap-1">
			<span class="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere] text-ink"
				>{feature.name}</span
			>
			<span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
				<span class="font-mono">{feature.key}</span>
				<span aria-hidden="true">·</span>
				<span class="tabular-nums"
					>{feature.journeys}
					{qaPlural(feature.journeys, 'journey')}{SEP}{feature.cases}
					{qaPlural(feature.cases, 'case')}</span
				>
				<span class="flex items-center gap-1">
					{#if feature.sizes.length}
						{#each feature.sizes as w (w)}
							<span
								class="rounded-md bg-raised px-2 py-0.5 font-mono text-xs text-muted tabular-nums"
								>{w}</span
							>
						{/each}
					{:else}
						No sizes
					{/if}
				</span>
			</span>
		</span>
		<span class="flex shrink-0 items-center gap-3 max-sm:w-full max-sm:flex-wrap">
			<QaStatusPill status={feature.status} flaky={feature.flaky} />
			<span class="w-16 shrink-0">
				{#if feature.openBugs > 0}
					<Badge tone="danger">{feature.openBugs} {qaPlural(feature.openBugs, 'bug')}</Badge>
				{:else}
					<span class="text-xs text-muted tabular-nums">0 bugs</span>
				{/if}
			</span>
			<span class="w-40 shrink-0 text-xs text-muted max-sm:ml-auto max-sm:w-auto sm:text-right"
				>{feature.lastTestedAt
					? ago(feature.lastTestedAt)
					: 'Never tested'}{#if feature.lastCommit}<span class="block sm:inline"
						><span class="max-sm:hidden">{SEP}</span><span class="font-mono"
							>{feature.lastCommit.slice(0, 7)}</span
						></span
					>{/if}</span
			>
		</span>
	</a>
</li>
