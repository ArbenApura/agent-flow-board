<script lang="ts">
	// IMPORTED TYPES
	import type { Device, Status } from './status';
	// IMPORTED CONSTANTS
	import { DEVICE_LABEL, DEVICE_ORDER, KIND_RUNS, STATUS_FILL, STATUS_LABEL } from './status';

	// -- REQUIRED PROPS -- //

	let {
		kind,
		results
	}: {
		kind: string;
		/** One entry per device the case ran at, or runs at (not run). */
		results: { device: Device; width: number; height: number; status: Status }[];
	} = $props();

	// -- REACTIVE STATES -- //

	const byDevice = $derived(new Map(results.map((r) => [r.device, r])));
	const custom = $derived(results.filter((r) => r.device === 'custom'));
	// Only a problem gets words: the devices that broke, under the bar
	const broken = $derived(
		results.filter((r) => r.status === 'fail' || r.status === 'blocked' || r.status === 'running')
	);
	const brokenTone = $derived(
		broken[0]?.status === 'fail'
			? 'text-danger'
			: broken[0]?.status === 'blocked'
				? 'text-warning'
				: 'text-info'
	);
	const name = (r: { device: Device; width: number; height: number }) =>
		r.device === 'custom' ? `${r.width} × ${r.height}` : DEVICE_LABEL[r.device];
	const summary = $derived(
		results.map((r) => `${name(r)} ${STATUS_LABEL[r.status].toLowerCase()}`).join(', ')
	);
</script>

<!-- THE DEVICE BAR: FOUR SEGMENTS IN A FIXED ORDER (WIDE, LAPTOP, TABLET, PHONE), A FIFTH PER CUSTOM SIZE, EACH IN ITS RESULT COLOUR -->
{#if kind !== 'ui'}
	<span class="text-xs text-muted">{KIND_RUNS[kind] ?? kind}</span>
{:else}
	<span class="flex flex-col items-start gap-1" role="img" aria-label={summary || 'No device yet'}>
		<span class="inline-flex shrink-0 gap-0.5 overflow-hidden rounded-full">
			{#each DEVICE_ORDER as d (d)}
				{@const r = byDevice.get(d)}
				<span
					class={['h-2 w-4', r ? STATUS_FILL[r.status] : 'bg-line']}
					title={`${DEVICE_LABEL[d]}: ${r ? STATUS_LABEL[r.status] : 'not in this case'}`}
				></span>
			{/each}
			{#each custom as c (`${c.width}x${c.height}`)}
				<span
					class={['h-2 w-4', STATUS_FILL[c.status]]}
					title={`${name(c)}: ${STATUS_LABEL[c.status]}`}
				></span>
			{/each}
		</span>
		{#if broken.length > 0}
			<span class={['text-xs font-medium whitespace-nowrap', brokenTone]}>
				{broken.map(name).join(', ')}
			</span>
		{/if}
	</span>
{/if}
