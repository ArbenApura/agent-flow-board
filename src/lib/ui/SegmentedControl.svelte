<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Component } from 'svelte';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';

	// -- TYPES -- //

	/** An option may carry a small icon beside its label. */
	type Option = {
		value: string;
		label: string;
		icon?: Component<{ size?: number; class?: string; 'aria-hidden'?: 'true' }>;
	};

	// -- REQUIRED PROPS -- //

	let {
		options,
		value = $bindable(),
		label,
		onchange,
		compactOnPhone = false,
		class: extra
	}: {
		options: Option[];
		value?: string;
		/** Names the group for screen readers. */
		label: string;
		onchange?: (value: string) => void;
		/** On a phone an option that has an icon shows the icon only, so a long row fits. The label stays for screen readers. */
		compactOnPhone?: boolean;
		class?: string;
	} = $props();

	// -- FUNCTIONS -- //

	function pick(next: string) {
		value = next;
		onchange?.(next);
	}

	// Arrow keys move the choice, as in a native radio group
	function onKey(e: KeyboardEvent, index: number) {
		const step =
			e.key === 'ArrowRight' || e.key === 'ArrowDown'
				? 1
				: e.key === 'ArrowLeft' || e.key === 'ArrowUp'
					? -1
					: 0;
		if (!step) return;
		e.preventDefault();
		const nextIndex = (index + step + options.length) % options.length;
		pick(options[nextIndex].value);
		const radios = (e.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>(
			'[role=radio]'
		);
		radios?.[nextIndex]?.focus();
	}
</script>

<div
	role="radiogroup"
	aria-label={label}
	class={cn(
		'inline-flex h-10 shrink-0 items-stretch rounded-lg border border-line bg-raised p-0.5 max-sm:h-11',
		extra
	)}
>
	{#each options as opt, i (opt.value)}
		<button
			type="button"
			role="radio"
			aria-checked={value === opt.value}
			tabindex={value === opt.value || (value === undefined && i === 0) ? 0 : -1}
			onclick={() => pick(opt.value)}
			onkeydown={(e) => onKey(e, i)}
			class={cn(
				'inline-flex h-full min-w-16 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
				compactOnPhone && opt.icon && 'max-sm:min-w-11 max-sm:px-2',
				value === opt.value
					? 'bg-surface text-ink shadow-[0_0_0_1px_var(--line)]'
					: 'text-muted hover:text-ink'
			)}
		>
			{#if opt.icon}
				{@const Icon = opt.icon}
				<Icon size={16} class="shrink-0" aria-hidden="true" />
			{/if}
			<span class={compactOnPhone && opt.icon ? 'max-sm:sr-only' : ''}>{opt.label}</span>
		</button>
	{/each}
</div>
