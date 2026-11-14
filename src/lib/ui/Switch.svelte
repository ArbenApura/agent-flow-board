<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		label,
		hint,
		checked = $bindable(false),
		disabled = false,
		onchange,
		class: extra,
		'data-testid': testid
	}: {
		label: string;
		hint?: string;
		checked?: boolean;
		disabled?: boolean;
		onchange?: (next: boolean) => void;
		class?: string;
		'data-testid'?: string;
	} = $props();

	// -- FUNCTIONS -- //

	function toggle() {
		if (disabled) return;
		checked = !checked;
		onchange?.(checked);
	}
</script>

<div class={cn('flex items-center justify-between gap-3 py-3', extra)}>
	<span class="flex min-w-0 flex-col">
		<span class="text-sm font-medium text-ink">{label}</span>
		{#if hint}<span class="text-xs text-muted">{hint}</span>{/if}
	</span>
	<!-- THE BUTTON IS THE 44 PX TOUCH TARGET, THE TRACK INSIDE IT IS THE DRAWN SWITCH -->
	<button
		type="button"
		role="switch"
		data-testid={testid}
		aria-checked={checked}
		aria-label={label}
		{disabled}
		onclick={toggle}
		class="inline-flex h-11 w-14 shrink-0 cursor-pointer items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
	>
		<span
			class={cn(
				'relative inline-block h-[26px] w-11 rounded-full border transition-colors',
				checked ? 'border-accent bg-accent' : 'border-line bg-raised'
			)}
		>
			<span
				class={cn(
					'absolute top-[2px] size-5 rounded-full transition-[left] motion-reduce:transition-none',
					checked ? 'left-[20px] bg-accent-ink' : 'left-[2px] bg-muted'
				)}
			></span>
		</span>
	</button>
</div>
