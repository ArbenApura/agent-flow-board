<script lang="ts">
	// IMPORTED TYPES
	import type { ConfigValue } from '#lib/board/mockups.js';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';

	// -- REQUIRED PROPS -- //

	let {
		screens,
		value,
		onpick,
		class: extra
	}: {
		/** The screens the mockup declared, in order. */
		screens: ConfigValue[];
		/** The key of the screen on show. */
		value: string;
		onpick: (key: string) => void;
		class?: string;
	} = $props();

	// -- STATES -- //

	let row = $state<HTMLElement>();

	// -- REACTIVE STATES -- //

	const index = $derived(
		Math.max(
			0,
			screens.findIndex((s) => s.value === value)
		)
	);

	// -- REACTIVE STATEMENTS -- //

	// The screen on show slides to the centre of the row, which scrolls sideways when the mockup has many screens
	$effect(() => {
		void value;
		const el = row;
		const active = el?.querySelector<HTMLElement>('[aria-current="step"]');
		if (!el || !active) return;
		const left =
			active.getBoundingClientRect().left -
			el.getBoundingClientRect().left +
			el.scrollLeft -
			(el.clientWidth - active.offsetWidth) / 2;
		el.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
	});
</script>

<!-- THE SCREENS OF THE MOCKUP: DRAWN BY THE BOARD, NEVER BY THE PAGE. ONE PILL FOR EACH SCREEN THE MOCKUP DECLARED -->
<div class={cn('flex min-w-0 items-center gap-1.5', extra)} data-testid="screen-strip">
	<button
		type="button"
		aria-label="Previous screen"
		disabled={index === 0}
		onclick={() => onpick(screens[index - 1].value)}
		class="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line bg-surface text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 max-sm:size-11"
	>
		<ChevronLeft size={16} aria-hidden="true" />
	</button>
	<div
		bind:this={row}
		role="group"
		aria-label="Screens of this mockup"
		class="flex min-w-0 flex-1 [scrollbar-width:none]! gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain [&::-webkit-scrollbar]:hidden"
	>
		{#each screens as s, i (s.value)}
			{@const on = s.value === value}
			<button
				type="button"
				aria-current={on ? 'step' : undefined}
				onclick={() => onpick(s.value)}
				class={cn(
					'inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-full border pr-3.5 pl-2 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent max-sm:h-11',
					on
						? 'border-accent bg-accent-soft font-semibold text-accent-text'
						: 'border-line bg-surface text-muted hover:text-ink'
				)}
			>
				<span
					class={cn(
						'inline-flex min-w-5 items-center justify-center rounded-full font-mono text-badge leading-5 font-semibold',
						on ? 'bg-accent text-accent-ink' : 'bg-raised text-muted'
					)}>{i + 1}</span
				>
				{s.label}
			</button>
		{/each}
	</div>
	<button
		type="button"
		aria-label="Next screen"
		disabled={index === screens.length - 1}
		onclick={() => onpick(screens[index + 1].value)}
		class="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line bg-surface text-ink hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 max-sm:size-11"
	>
		<ChevronRight size={16} aria-hidden="true" />
	</button>
</div>
