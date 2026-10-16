<script module lang="ts">
	// -- DEP-TYPES -- //
	import type { Component } from 'svelte';

	// -- TYPES -- //

	export type MenuItem = {
		label: string;
		onselect: () => void;
		icon?: Component<{ size?: number; class?: string }>;
		danger?: boolean;
		disabled?: boolean;
	};
</script>

<script lang="ts">
	// -- MODULES -- //
	import Button from '#lib/ui/Button.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import DotsThree from 'phosphor-svelte/lib/DotsThree';

	// -- REQUIRED PROPS -- //

	let {
		items,
		label = 'More actions'
	}: {
		items: MenuItem[];
		/** Names the icon button for screen readers. */
		label?: string;
	} = $props();

	// -- STATES -- //

	let open = $state(false);
	let list = $state<HTMLElement>();

	// -- FUNCTIONS -- //

	function onKey(e: KeyboardEvent) {
		const enabled = [
			...(list?.querySelectorAll<HTMLElement>('[role=menuitem]:not([aria-disabled=true])') ?? [])
		];
		const i = enabled.indexOf(document.activeElement as HTMLElement);
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			enabled[(i + 1) % enabled.length]?.focus();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			enabled[(i - 1 + enabled.length) % enabled.length]?.focus();
		}
	}

	$effect(() => {
		if (open)
			queueMicrotask(() =>
				list?.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled=true])')?.focus()
			);
	});
</script>

<Popover bind:open placement="bottom-end" role="menu" {label}>
	{#snippet trigger({ props, toggle })}
		<Button variant="ghost" iconOnly aria-label={label} onclick={toggle} {...props}>
			<DotsThree size={20} weight="bold" />
		</Button>
	{/snippet}
	{#snippet children({ close })}
		<div bind:this={list} role="presentation" onkeydown={onKey}>
			{#each items as item (item.label)}
				<button
					type="button"
					role="menuitem"
					aria-disabled={item.disabled || undefined}
					onclick={() => {
						if (item.disabled) return;
						item.onselect();
						close();
					}}
					class={cn(
						'flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-sm hover:bg-raised focus-visible:bg-raised focus-visible:outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
						item.danger ? 'text-danger' : 'text-ink'
					)}
				>
					{#if item.icon}<item.icon size={16} />{/if}
					{item.label}
				</button>
			{/each}
		</div>
	{/snippet}
</Popover>
