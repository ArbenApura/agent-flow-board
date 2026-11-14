<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { HTMLInputAttributes } from 'svelte/elements';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';

	// -- REQUIRED PROPS -- //

	let {
		label,
		checked = $bindable(false),
		hint,
		class: extra,
		...rest
	}: {
		label: string;
		checked?: boolean;
		hint?: string;
		class?: string;
	} & Omit<HTMLInputAttributes, 'class' | 'checked' | 'type'> = $props();
</script>

<!-- THE WHOLE ROW IS THE TOUCH TARGET, THE NATIVE INPUT STAYS FOR KEYBOARD AND SCREEN READERS -->
<label class={cn('group flex min-h-11 cursor-pointer items-start gap-3 py-2', extra)}>
	<span class="relative mt-0.5 inline-flex size-5 shrink-0">
		<input
			type="checkbox"
			bind:checked
			class="peer absolute inset-0 size-5 cursor-pointer appearance-none rounded-[5px] border-[1.5px] border-muted bg-surface checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
			{...rest}
		/>
		<Check
			size={14}
			strokeWidth={3}
			class="pointer-events-none absolute top-[3px] left-[3px] text-accent-ink opacity-0 peer-checked:opacity-100"
		/>
	</span>
	<span class="flex flex-col">
		<span class="text-sm text-ink">{label}</span>
		{#if hint}<span class="text-xs text-muted">{hint}</span>{/if}
	</span>
</label>
