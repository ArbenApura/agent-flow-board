<script module lang="ts">
	// -- DEP-TYPES -- //
	import type { Component } from 'svelte';

	// -- TYPES -- //

	export type MenuRow = {
		key: string;
		label: string;
		hint?: string;
		/** A short word on the right, such as the kind of a link target. */
		tag?: string;
		/** A reference shown in the mono face, such as N-12. */
		ref?: string | null;
		icon?: Component<{ size?: number }>;
	};
</script>

<script lang="ts">
	// -- TYPES -- //
	import type { Box } from '#lib/ui/position.js';
	// -- DEP-MODULES -- //
	import { tick } from 'svelte';
	// -- MODULES -- //
	import { portal } from '#lib/actions/portal.js';
	import { optionId } from '#lib/board/notes/editorMenu.js';
	import { cn } from '#lib/ui/cn.js';
	import { boxOf, place } from '#lib/ui/position.js';

	// -- REQUIRED PROPS -- //

	let {
		id,
		label,
		rows,
		active,
		anchor,
		onpick,
		onhover,
		status = ''
	}: {
		/** The id of the listbox. The editor names it in aria-controls and its rows in aria-activedescendant. */
		id: string;
		label: string;
		rows: MenuRow[];
		/** The highlighted row. */
		active: number;
		/** The caret, in viewport coordinates. Null hides the menu until the editor can say where it is. */
		anchor: Box | null;
		onpick: (index: number) => void;
		onhover: (index: number) => void;
		/** A line shown instead of rows (searching, nothing found). */
		status?: string;
	} = $props();

	// -- STATES -- //

	let panel = $state<HTMLDivElement>();
	let pos = $state({ x: 0, y: 0 });
	/** The portal moves this out of the root layout, so the mode is copied onto it. */
	let mode = $state('light');

	// -- REACTIVE STATEMENTS -- //

	$effect(() => {
		const el = document.documentElement;
		mode = el.getAttribute('data-mode') ?? 'light';
		const watch = new MutationObserver(() => (mode = el.getAttribute('data-mode') ?? 'light'));
		watch.observe(el, { attributes: true, attributeFilter: ['data-mode'] });
		return () => watch.disconnect();
	});

	// The panel sits under the caret, or above it when there is no room below
	$effect(() => {
		const a = anchor;
		void rows.length;
		void status;
		const p = panel;
		if (!a || !p) return;
		void tick().then(() => {
			const placed = place(
				a,
				boxOf(p),
				{ width: innerWidth, height: innerHeight },
				'bottom-start',
				4
			);
			pos = { x: placed.x, y: placed.y };
		});
	});

	// The highlighted row stays inside the scrolled list, without moving the page
	$effect(() => {
		const list = panel;
		const row = list?.querySelector<HTMLElement>(`[id="${optionId(id, active)}"]`);
		if (!list || !row) return;
		if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
		else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
			list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
	});
</script>

{#if anchor}
	<!-- RUNTIME POSITION OF THE MENU, FROM THE CARET BOX -->
	<div
		bind:this={panel}
		use:portal
		{id}
		role="listbox"
		tabindex="-1"
		aria-label={label}
		data-mode={mode}
		data-testid="editor-menu"
		onmousedown={(e) => e.preventDefault()}
		style="position:fixed;left:{pos.x}px;top:{pos.y}px;"
		class="z-[2500] max-h-[min(20rem,calc(100vh-16px))] w-72 max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-1 text-sm text-ink shadow-[var(--elev-1)] shadow-[var(--shadow-pop)]"
	>
		{#each rows as row, i (row.key)}
			{@const Icon = row.icon}
			<div
				id={optionId(id, i)}
				role="option"
				aria-selected={i === active}
				tabindex="-1"
				onclick={() => onpick(i)}
				onmousemove={() => i !== active && onhover(i)}
				onkeydown={(e) => e.key === 'Enter' && onpick(i)}
				data-testid="editor-menu-row"
				class={cn(
					'flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5',
					i === active ? 'bg-accent-soft text-accent-text' : 'text-ink'
				)}
			>
				{#if Icon}<Icon size={18} />{/if}
				<span class="flex min-w-0 flex-1 flex-col">
					<span class="truncate font-medium">{row.label}</span>
					{#if row.hint}<span class="truncate text-xs text-muted">{row.hint}</span>{/if}
				</span>
				{#if row.ref}<span class="shrink-0 font-mono text-xs text-muted">{row.ref}</span>{/if}
				{#if row.tag}<span class="shrink-0 text-xs text-muted">{row.tag}</span>{/if}
			</div>
		{/each}
		{#if status}
			<div role="presentation" class="flex min-h-12 items-center px-3 text-muted">{status}</div>
		{/if}
	</div>
{/if}
