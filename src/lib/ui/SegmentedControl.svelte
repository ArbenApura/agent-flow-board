<script lang="ts">
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- TYPES -- //

	type Option = { value: string; label: string };

	// -- REQUIRED PROPS -- //

	let {
		options,
		value = $bindable(),
		label,
		onchange,
		class: extra
	}: {
		options: Option[];
		value?: string;
		/** Names the group for screen readers. */
		label: string;
		onchange?: (value: string) => void;
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
	class={cn('inline-flex rounded-lg border border-line bg-raised p-0.5', extra)}
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
				'h-11 min-w-11 cursor-pointer rounded-md px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
				value === opt.value
					? 'bg-surface text-ink shadow-[0_0_0_1px_var(--line)]'
					: 'text-muted hover:text-ink'
			)}
		>
			{opt.label}
		</button>
	{/each}
</div>
