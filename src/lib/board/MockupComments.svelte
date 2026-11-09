<script lang="ts">
	// -- TYPES -- //
	import type { CommentRow, PinFilter } from '#lib/board/mockups.js';
	// -- MODULES -- //
	import { PIN_FILTERS, PIN_FILTER_LABEL } from '#lib/board/mockups.js';
	import { ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import History from '@lucide/svelte/icons/history';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import Trash from '@lucide/svelte/icons/trash';
	import X from '@lucide/svelte/icons/x';

	// -- REQUIRED PROPS -- //

	let {
		id,
		open,
		pins,
		filter = $bindable('open'),
		openCount,
		device,
		selected = null,
		canWrite,
		elsewhere = [],
		onclose,
		ontoggle,
		onselect,
		onresolve,
		onremove
	}: {
		/** The id the Comments button points at with aria-controls. */
		id: string;
		open: boolean;
		/** The comments to list: those on the device on show that the filter lets through, numbered. */
		pins: CommentRow[];
		filter?: PinFilter;
		/** Open comments on the device on show. */
		openCount: number;
		/** The plain name of the device on show. */
		device: string;
		selected?: string | null;
		canWrite: boolean;
		/** Other places with open comments: another device, another version. */
		elsewhere?: {
			key: 'device' | 'version';
			text: string;
			action: string;
			label: string;
			onact?: () => void;
			href?: string;
		}[];
		onclose: () => void;
		/** On a phone the whole header opens and closes the sheet. */
		ontoggle: () => void;
		onselect: (id: string) => void;
		onresolve: (id: string, resolved: boolean) => void;
		onremove: (id: string) => void;
	} = $props();

	// -- STATES -- //

	let list = $state<HTMLElement>();

	// -- REACTIVE STATEMENTS -- //

	// A pin picked on the mockup brings its comment into view in the list
	$effect(() => {
		const id = selected;
		if (!id || !open) return;
		list
			?.querySelector<HTMLElement>(`[data-pin="${CSS.escape(id)}"]`)
			?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	});
</script>

<!-- A COMMENTS DRAWER THAT IS NOT MODAL: NO BACKDROP, NO FOCUS TRAP, NO SCROLL LOCK, SO THE PINS AND THE FRAME STAY USABLE. ON A DESKTOP OR TABLET IT SLIDES OVER THE STAGE, ON A PHONE IT IS A SHEET AT THE BOTTOM -->
<aside
	{id}
	aria-label="Comments"
	data-testid="comments-drawer"
	class={cn(
		'z-30 flex flex-col rounded-xl border border-line bg-surface shadow-[var(--shadow-pop)] transition-[translate,visibility] duration-200 motion-reduce:transition-none max-md:[&_[data-sheet-body]]:transition-[visibility] max-md:[&_[data-sheet-body]]:duration-200',
		'md:absolute md:top-3 md:right-3 md:bottom-3 md:w-[340px]',
		'max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[78dvh] max-md:rounded-b-none',
		open
			? 'visible translate-x-0 translate-y-0'
			: 'invisible max-md:translate-y-full md:translate-x-[calc(100%+24px)]'
	)}
>
	<!-- THE HEADER. ON A PHONE THE WHOLE ROW IS ONE BUTTON THAT OPENS AND CLOSES THE SHEET -->
	<div class="relative flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
		<button
			type="button"
			class="absolute inset-0 cursor-pointer rounded-t-xl md:hidden"
			aria-label={open ? 'Hide the comments' : 'Show the comments'}
			aria-expanded={open}
			aria-controls={id}
			onclick={ontoggle}
		></button>
		<span
			class="pointer-events-none absolute top-1.5 left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-line md:hidden"
			aria-hidden="true"
		></span>
		<h2
			class="pointer-events-none relative flex min-h-8 flex-1 items-center gap-2 text-lg font-semibold"
		>
			Comments
			<Badge tone="accent">{openCount} open</Badge>
		</h2>
		<Button
			size="sm"
			variant="subtle"
			iconOnly
			aria-label="Close the comments"
			class="relative"
			onclick={onclose}
		>
			<X size={16} />
		</Button>
		<div data-sheet-body class="relative w-full">
			<SegmentedControl
				label="Show"
				class="w-full [&>button]:flex-1"
				value={filter}
				options={PIN_FILTERS.map((f) => ({ value: f, label: PIN_FILTER_LABEL[f] }))}
				onchange={(v) => (filter = v as PinFilter)}
			/>
		</div>
	</div>
	<div
		bind:this={list}
		data-sheet-body
		class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3"
		data-testid="pins"
	>
		{#if pins.length === 0}
			<p class="px-3 py-5 text-center text-sm text-muted" data-testid="pins-empty">
				{filter === 'done'
					? `Nothing resolved on ${device} yet.`
					: canWrite
						? `No open comments on ${device}. Press C and click the mockup to add one.`
						: `No open comments on ${device}.`}
			</p>
		{/if}
		{#each pins as p (p.id)}
			<div
				data-pin={p.id}
				data-testid="pin"
				class={cn(
					'flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 hover:border-accent',
					selected === p.id ? 'border-accent bg-accent-soft' : 'border-line bg-surface'
				)}
			>
				<!-- THE COMMENT IS ONE REAL BUTTON THAT SHOWS ITS PIN. THE ACTIONS BELOW ARE NOT INSIDE IT -->
				<button
					type="button"
					class="flex min-h-8 w-full cursor-pointer gap-2.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					aria-label={`Show comment ${p.n} on the mockup`}
					onclick={() => onselect(p.id)}
				>
					<span
						class={cn(
							'inline-flex size-6 shrink-0 items-center justify-center rounded-full text-badge font-semibold',
							p.resolved ? 'bg-muted text-surface' : 'bg-accent text-accent-ink'
						)}
						aria-hidden="true">{p.n}</span
					>
					<!-- PLAIN TEXT ONLY: A COMMENT IS WRITTEN BY A PERSON, SO IT IS NEVER RENDERED AS MARKUP -->
					<span class="min-w-0 flex-1 text-sm">
						<span class="block text-xs text-muted">
							{p.author}, {ago(p.createdAt)}{#if p.resolved && p.resolvedBy}, resolved by {p.resolvedBy}{/if}
						</span>
						<span
							class={cn(
								'[overflow-wrap:anywhere] whitespace-pre-wrap',
								p.resolved ? 'text-muted line-through' : 'text-ink'
							)}>{p.body}</span
						>
					</span>
				</button>
				{#if canWrite}
					<div class="flex flex-wrap items-center gap-1.5 pl-[34px]">
						<Button
							size="sm"
							data-testid={p.resolved ? 'reopen-pin' : 'resolve-pin'}
							onclick={() => onresolve(p.id, !p.resolved)}
						>
							{#if p.resolved}<RotateCcw size={14} /> Reopen{:else}<CircleCheck size={14} /> Resolve{/if}
						</Button>
						<Button
							size="sm"
							variant="subtle"
							iconOnly
							aria-label={`Remove comment ${p.n}`}
							data-testid="remove-pin"
							onclick={() => onremove(p.id)}
						>
							<Trash size={14} />
						</Button>
					</div>
				{/if}
			</div>
		{/each}
	</div>
	{#if elsewhere.length}
		<div data-sheet-body class="flex flex-col gap-1 border-t border-line px-3 py-2">
			{#each elsewhere as row (row.key)}
				<div class="flex min-h-8 items-center gap-2 text-xs text-muted">
					{#if row.key === 'device'}<Smartphone size={16} aria-hidden="true" />{:else}<History
							size={16}
							aria-hidden="true"
						/>{/if}
					<span class="min-w-0 flex-1 truncate">{row.text}</span>
					<Button
						size="sm"
						href={row.href}
						aria-label={row.label}
						onclick={row.onact}
						data-testid={`elsewhere-${row.key}`}>{row.action}</Button
					>
				</div>
			{/each}
		</div>
	{/if}
</aside>
