<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Component } from 'svelte';
	// -- MODULES -- //
	import { LABEL } from '#lib/board/sidebar-classes.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		href,
		label,
		icon: Glyph,
		active = false
	}: {
		href: string;
		label: string;
		icon: Component<{ size?: number; class?: string }>;
		active?: boolean;
	} = $props();
</script>

<!-- ONE ROW OF A SIDEBAR. AN ICON AND A LABEL, THE LABEL FADES WHILE THE SIDEBAR IS THE SLIM RAIL. THE ICON NEVER MOVES -->
<a
	{href}
	title={label}
	aria-current={active ? 'page' : undefined}
	class={cn(
		'flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-[11px] text-sm text-muted transition-colors hover:bg-raised hover:text-ink',
		active &&
			'bg-accent-soft font-medium text-accent-text hover:bg-accent-soft hover:text-accent-text'
	)}
>
	<Glyph size={18} class="shrink-0" />
	<span class={LABEL}>{label}</span>
</a>
