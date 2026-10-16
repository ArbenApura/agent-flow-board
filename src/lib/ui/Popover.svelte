<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	import type { Placement } from '#lib/ui/position.js';
	// -- DEP-MODULES -- //
	import { tick } from 'svelte';
	// -- MODULES -- //
	import { clickOutside } from '#lib/actions/clickOutside.js';
	import { portal } from '#lib/actions/portal.js';
	import { boxOf, place } from '#lib/ui/position.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		open = $bindable(false),
		trigger,
		children,
		placement = 'bottom-start',
		matchWidth = false,
		role = 'dialog',
		label,
		class: extra
	}: {
		open?: boolean;
		/** Renders the control that opens the panel. Spread `props` on the button. */
		trigger: Snippet<[{ props: Record<string, unknown>; toggle: () => void; open: boolean }]>;
		children: Snippet<[{ close: () => void }]>;
		placement?: Placement;
		matchWidth?: boolean;
		role?: 'dialog' | 'menu' | 'listbox';
		label?: string;
		class?: string;
	} = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();
	const panelId = `${uid}-panel`;

	// -- STATES -- //

	let anchor = $state<HTMLElement>();
	let panel = $state<HTMLElement>();
	let pos = $state({ x: 0, y: 0 });
	let width = $state<number | undefined>(undefined);

	// -- FUNCTIONS -- //

	function toggle() {
		open = !open;
	}

	function close() {
		open = false;
		// Focus goes back to the control that opened the panel
		(anchor?.querySelector('button, [tabindex]') as HTMLElement | null)?.focus();
	}

	async function reposition() {
		if (!anchor || !panel) return;
		await tick();
		const a = boxOf(anchor);
		width = matchWidth ? a.width : undefined;
		const p = panel.getBoundingClientRect();
		const placed = place(
			a,
			{ width: matchWidth ? a.width : p.width, height: p.height },
			{ width: innerWidth, height: innerHeight },
			placement
		);
		pos = { x: placed.x, y: placed.y };
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			e.stopPropagation();
			close();
		}
	}

	// -- REACTIVE STATEMENTS -- //

	$effect(() => {
		if (!open) return;
		reposition();
		const on = () => reposition();
		// Escape closes the panel wherever focus is, as it often stays on the trigger
		const esc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') close();
		};
		addEventListener('resize', on);
		addEventListener('scroll', on, true);
		document.addEventListener('keydown', esc);
		return () => {
			removeEventListener('resize', on);
			removeEventListener('scroll', on, true);
			document.removeEventListener('keydown', esc);
		};
	});
</script>

<span bind:this={anchor} class="inline-flex">
	{@render trigger({
		props: {
			'aria-haspopup': role === 'dialog' ? 'dialog' : role,
			'aria-expanded': open,
			'aria-controls': open ? panelId : undefined
		},
		toggle,
		open
	})}
</span>

{#if open}
	<!-- DYNAMIC RUNTIME POSITION OF THE FLOATING PANEL -->
	<div
		bind:this={panel}
		use:portal
		use:clickOutside={{ onOutside: () => (open = false), ignore: [anchor] }}
		id={panelId}
		{role}
		aria-label={label}
		tabindex="-1"
		onkeydown={onKey}
		style="position:fixed;left:{pos.x}px;top:{pos.y}px;{width ? `width:${width}px;` : ''}"
		class={cn(
			'z-[2500] max-h-[min(24rem,calc(100vh-16px))] min-w-40 overflow-auto rounded-lg border border-line bg-surface p-1 text-sm text-ink shadow-[var(--shadow-pop)] outline-none',
			extra
		)}
	>
		{@render children({ close })}
	</div>
{/if}
