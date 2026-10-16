<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Component, Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	// -- MODULES -- //
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		children,
		header,
		footer,
		title,
		description,
		icon: Icon,
		tone = 'default',
		padded = true,
		class: extra,
		...rest
	}: {
		children: Snippet;
		header?: Snippet;
		footer?: Snippet;
		/** Shortcut for the common header: an icon, a title and one line saying what the card is. */
		title?: string;
		description?: string;
		icon?: Component<{ size?: number; class?: string }>;
		/** The danger zone: a red edge and a red title, for a card of destructive actions. */
		tone?: 'default' | 'danger';
		padded?: boolean;
		class?: string;
	} & Omit<HTMLAttributes<HTMLDivElement>, 'class'> = $props();
</script>

<div
	data-card
	class={cn(
		'overflow-hidden rounded-xl border bg-surface text-ink shadow-[var(--elev-1)]',
		tone === 'danger' ? 'border-danger/40' : 'border-line',
		extra
	)}
	{...rest}
>
	{#if header}
		<div class="flex items-center gap-2 border-b border-line px-4 py-3 max-sm:px-3.5">
			{@render header()}
		</div>
	{:else if title}
		<div class="flex items-center gap-3 border-b border-line px-4 py-3 max-sm:px-3.5">
			{#if Icon}
				<span
					class={cn(
						'inline-flex size-9 shrink-0 items-center justify-center rounded-lg',
						tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent-text'
					)}
					aria-hidden="true"><Icon size={18} /></span
				>
			{/if}
			<div class="min-w-0">
				<h2 class={cn('text-lg leading-6 font-semibold', tone === 'danger' && 'text-danger')}>
					{title}
				</h2>
				{#if description}<p class="text-sm text-muted">{description}</p>{/if}
			</div>
		</div>
	{/if}
	<div class={cn(padded && 'p-4 max-sm:p-3.5')}>
		{@render children()}
	</div>
	{#if footer}
		<div class="flex items-center justify-end gap-2 border-t border-line px-4 py-3 max-sm:px-3.5">
			{@render footer()}
		</div>
	{/if}
</div>
