<script lang="ts">
	// IMPORTED MODULES
	import Popover from '#lib/ui/Popover.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { MONTHS, WEEKDAYS, formatLong, monthGrid, parseIso, shiftMonth } from '#lib/ui/dates.js';
	// IMPORTED DEP-COMPONENTS
	import Calendar from '@lucide/svelte/icons/calendar';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';

	// -- REQUIRED PROPS -- //

	let {
		label,
		value = $bindable(''),
		hint,
		error,
		min,
		max,
		onchange,
		class: extra
	}: {
		label: string;
		/** A local date as YYYY-MM-DD, or empty. */
		value?: string;
		hint?: string;
		error?: string;
		min?: string;
		max?: string;
		onchange?: (value: string) => void;
		class?: string;
	} = $props();

	// -- STATES -- //

	let open = $state(false);
	const today = new Date();
	let view = $state({ year: today.getFullYear(), month: today.getMonth() });

	// -- REACTIVE STATES -- //

	const grid = $derived(monthGrid(view.year, view.month));

	// -- FUNCTIONS -- //

	function show() {
		const p = parseIso(value);
		view = p ? { year: p.y, month: p.m } : { year: today.getFullYear(), month: today.getMonth() };
	}

	function pick(iso: string, close: () => void) {
		if ((min && iso < min) || (max && iso > max)) return;
		value = iso;
		onchange?.(iso);
		close();
	}

	$effect(() => {
		if (open) show();
	});
</script>

<div class={cn('flex flex-col gap-1', extra)}>
	<span class="text-xs font-medium text-muted">{label}</span>
	<Popover bind:open placement="bottom-start" label={`Choose ${label.toLowerCase()}`}>
		{#snippet trigger({ props, toggle })}
			<button
				type="button"
				{...props}
				onclick={toggle}
				aria-label={value ? `${label}, ${formatLong(value)}` : label}
				class={cn(
					'flex h-10 w-full min-w-44 cursor-pointer items-center justify-between gap-2 rounded-lg border bg-surface px-3 text-left text-sm shadow-[var(--elev-1)] transition-[border-color,box-shadow] duration-150 focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent-soft focus-visible:outline-none max-sm:h-11',
					error ? 'border-danger' : 'border-line',
					value ? 'text-ink' : 'text-muted'
				)}
			>
				<span>{value ? formatLong(value) : 'Pick a date'}</span>
				<Calendar size={16} class="shrink-0 text-muted" />
			</button>
		{/snippet}
		{#snippet children({ close })}
			<div class="w-72 p-2">
				<div class="mb-1 flex items-center justify-between">
					<button
						type="button"
						aria-label="Previous month"
						class="inline-flex size-11 cursor-pointer items-center justify-center rounded-lg hover:bg-raised"
						onclick={() => (view = shiftMonth(view.year, view.month, -1))}
					>
						<ChevronLeft size={16} />
					</button>
					<span class="text-sm font-semibold" aria-live="polite"
						>{MONTHS[view.month]} {view.year}</span
					>
					<button
						type="button"
						aria-label="Next month"
						class="inline-flex size-11 cursor-pointer items-center justify-center rounded-lg hover:bg-raised"
						onclick={() => (view = shiftMonth(view.year, view.month, 1))}
					>
						<ChevronRight size={16} />
					</button>
				</div>
				<div class="grid grid-cols-7 text-center text-xs text-muted">
					{#each WEEKDAYS as w (w)}<span class="py-1">{w}</span>{/each}
				</div>
				<div class="grid grid-cols-7">
					{#each grid as d (d.iso)}
						{@const off = (min && d.iso < min) || (max && d.iso > max)}
						<button
							type="button"
							disabled={!!off}
							aria-label={formatLong(d.iso)}
							aria-pressed={d.iso === value}
							onclick={() => pick(d.iso, close)}
							class={cn(
								'inline-flex size-10 cursor-pointer items-center justify-center rounded-lg text-sm hover:bg-raised disabled:cursor-not-allowed disabled:opacity-30',
								!d.inMonth && 'text-muted',
								d.iso === value && 'bg-accent text-accent-ink hover:bg-accent'
							)}
						>
							{d.day}
						</button>
					{/each}
				</div>
			</div>
		{/snippet}
	</Popover>
	{#if error}
		<p role="alert" class="text-xs text-danger">{error}</p>
	{:else if hint}
		<p class="text-xs text-muted">{hint}</p>
	{/if}
</div>
