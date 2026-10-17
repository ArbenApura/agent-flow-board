<script module lang="ts">
	// -- TYPES -- //

	export type SelectOption = {
		value: string;
		label: string;
		hint?: string;
		disabled?: boolean;
		dot?: string;
	};
</script>

<script lang="ts">
	// -- MODULES -- //
	import Popover from '#lib/ui/Popover.svelte';
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Check from '@lucide/svelte/icons/check';

	// -- REQUIRED PROPS -- //

	let {
		options,
		value = $bindable(),
		label,
		placeholder = 'Choose',
		invalid = false,
		disabled = false,
		onchange,
		class: extra
	}: {
		/** Every value must be unique. De-duplicate in the caller. */
		options: SelectOption[];
		value?: string;
		/** Names the control for screen readers. */
		label: string;
		placeholder?: string;
		invalid?: boolean;
		disabled?: boolean;
		onchange?: (value: string) => void;
		class?: string;
	} = $props();

	// -- STATES -- //

	let open = $state(false);
	let active = $state(0);

	// -- REACTIVE STATES -- //

	const selected = $derived(options.find((o) => o.value === value));

	// -- FUNCTIONS -- //

	function pick(opt: SelectOption, close: () => void) {
		if (opt.disabled) return;
		value = opt.value;
		onchange?.(opt.value);
		close();
	}

	function onTriggerKey(e: KeyboardEvent) {
		if (disabled) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!open) {
				open = true;
				active = Math.max(
					0,
					options.findIndex((o) => o.value === value)
				);
			} else {
				move(e.key === 'ArrowDown' ? 1 : -1);
			}
		} else if ((e.key === 'Enter' || e.key === ' ') && open) {
			e.preventDefault();
			const opt = options[active];
			if (opt) pick(opt, () => (open = false));
		}
	}

	function move(step: number) {
		for (let i = 1; i <= options.length; i++) {
			const next = (active + step * i + options.length * i) % options.length;
			if (!options[next]?.disabled) {
				active = next;
				return;
			}
		}
	}
</script>

<Popover
	bind:open
	placement="bottom-start"
	matchWidth
	role="listbox"
	{label}
	class={cn('p-1', extra)}
>
	{#snippet trigger({ props, toggle })}
		<button
			type="button"
			{...props}
			{disabled}
			aria-label={label}
			onclick={toggle}
			onkeydown={onTriggerKey}
			class={cn(
				'flex h-10 w-full min-w-40 cursor-pointer items-center justify-between gap-2 rounded-lg border bg-surface px-3 text-left text-sm shadow-[var(--elev-1)] transition-[border-color,box-shadow] duration-150 focus-visible:border-accent focus-visible:ring-4 focus-visible:ring-accent-soft focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 max-sm:h-11',
				invalid ? 'border-danger' : 'border-line',
				selected ? 'text-ink' : 'text-muted'
			)}
		>
			<span class="flex min-w-0 items-center gap-2">
				{#if selected?.dot}<span class={cn('size-2.5 shrink-0 rounded-full', selected.dot)}
					></span>{/if}
				<span class="truncate">{selected?.label ?? placeholder}</span>
			</span>
			<ChevronDown size={16} class="shrink-0 text-muted" />
		</button>
	{/snippet}
	{#snippet children({ close })}
		{#each options as opt, i (opt.value)}
			<!-- Options keep focus on the trigger, so the pick runs on click only -->
			<div
				role="option"
				tabindex="-1"
				aria-selected={opt.value === value}
				aria-disabled={opt.disabled || undefined}
				onmousedown={(e) => e.preventDefault()}
				onkeydown={() => {}}
				onclick={() => pick(opt, close)}
				onpointerenter={() => (active = i)}
				class={cn(
					'flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5',
					active === i && 'bg-raised',
					opt.disabled && 'cursor-not-allowed opacity-50'
				)}
			>
				<span class="flex min-w-0 items-center gap-2">
					{#if opt.dot}<span class={cn('size-2.5 shrink-0 rounded-full', opt.dot)}></span>{/if}
					<span class="flex min-w-0 flex-col">
						<span class="truncate">{opt.label}</span>
						{#if opt.hint}<span class="truncate text-xs text-muted">{opt.hint}</span>{/if}
					</span>
				</span>
				{#if opt.value === value}<Check size={16} class="shrink-0 text-accent-text" />{/if}
			</div>
		{/each}
	{/snippet}
</Popover>
