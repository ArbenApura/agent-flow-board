<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Info from '@lucide/svelte/icons/info';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';

	// -- REQUIRED PROPS -- //

	let {
		tone = 'danger',
		children,
		class: extra,
		...rest
	}: {
		tone?: 'danger' | 'warning' | 'info';
		children: Snippet;
		class?: string;
		'data-testid'?: string;
	} = $props();

	// -- CONSTANTS -- //

	const TONE = {
		danger: { icon: CircleAlert, box: 'bg-danger-soft text-danger', role: 'alert' },
		warning: { icon: TriangleAlert, box: 'bg-warning-soft text-warning', role: 'alert' },
		info: { icon: Info, box: 'bg-info-soft text-info', role: 'status' }
	} as const;

	// -- REACTIVE STATES -- //

	const t = $derived(TONE[tone]);
</script>

<!-- ONE INLINE NOTICE FOR EVERY PAGE. THE ICON CARRIES THE MEANING SO COLOUR IS NEVER ALONE -->
<div
	role={t.role}
	class={cn('flex items-start gap-3 rounded-lg border border-line p-3 text-sm', t.box, extra)}
	{...rest}
>
	<t.icon size={18} class="mt-px shrink-0" aria-hidden="true" />
	<div class="min-w-0 flex-1">{@render children()}</div>
</div>
