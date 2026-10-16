<script lang="ts">
	// -- MODULES -- //
	import Select from '#lib/ui/Select.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { formatTime, parseTime } from '#lib/ui/dates.js';

	// -- REQUIRED PROPS -- //

	let {
		label,
		value = $bindable('09:00'),
		hint,
		minuteStep = 5,
		onchange,
		class: extra
	}: {
		label: string;
		/** 24 hour time as HH:MM. */
		value?: string;
		hint?: string;
		minuteStep?: number;
		onchange?: (value: string) => void;
		class?: string;
	} = $props();

	// -- CONSTANTS -- //

	const HOURS = Array.from({ length: 24 }, (_, h) => ({
		value: String(h),
		label: String(h).padStart(2, '0')
	}));

	// -- REACTIVE STATES -- //

	const parsed = $derived(parseTime(value) ?? { h: 9, m: 0 });
	const minutes = $derived(
		Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => ({
			value: String(i * minuteStep),
			label: String(i * minuteStep).padStart(2, '0')
		}))
	);

	// -- FUNCTIONS -- //

	function set(h: number, m: number) {
		value = formatTime(h, m);
		onchange?.(value);
	}
</script>

<div class={cn('flex flex-col gap-1', extra)}>
	<span class="text-xs font-medium text-muted">{label}</span>
	<div class="flex items-center gap-2">
		<Select
			label={`${label}, hour`}
			options={HOURS}
			value={String(parsed.h)}
			onchange={(h) => set(Number(h), parsed.m)}
			class="w-24"
		/>
		<span aria-hidden="true" class="text-muted">:</span>
		<Select
			label={`${label}, minute`}
			options={minutes}
			value={String(parsed.m)}
			onchange={(m) => set(parsed.h, Number(m))}
			class="w-24"
		/>
	</div>
	{#if hint}<p class="text-xs text-muted">{hint}</p>{/if}
</div>
