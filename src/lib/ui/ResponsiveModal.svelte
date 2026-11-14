<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	// IMPORTED MODULES
	import { focusTrap } from '#lib/actions/focusTrap.js';
	import { portal } from '#lib/actions/portal.js';
	import { lockScroll, unlockScroll } from '#lib/actions/scrollLock.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import X from '@lucide/svelte/icons/x';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		title,
		children,
		footer,
		busy = false,
		size = 'md',
		variant = 'dialog'
	}: {
		/** Always mounted with this flag, never inside an {#if}, so the out transition plays. */
		open: boolean;
		onclose: () => void;
		title: string;
		children: Snippet;
		footer?: Snippet;
		/** While true the dialog cannot be closed (an action is running). */
		busy?: boolean;
		size?: 'sm' | 'md' | 'lg';
		/** A drawer slides in from the right on a wide screen, so a record can be read next to the page it came from. */
		variant?: 'dialog' | 'drawer' | 'top';
	} = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();
	const titleId = `${uid}-title`;
	const OUT_MS = 150;
	const WIDTHS = { sm: 'sm:max-w-[400px]', md: 'sm:max-w-[480px]', lg: 'sm:max-w-[640px]' };

	// -- STATES -- //

	/** Stays true for the out transition, so the content does not flash blank while closing. */
	let mounted = $state(false);
	let shown = $state(false);

	// -- FUNCTIONS -- //

	function requestClose() {
		if (!busy) onclose();
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			requestClose();
		}
	}

	// -- REACTIVE STATEMENTS -- //

	$effect(() => {
		if (open) {
			mounted = true;
			lockScroll();
			const frame = requestAnimationFrame(() => (shown = true));
			return () => {
				cancelAnimationFrame(frame);
				unlockScroll();
				shown = false;
				const t = setTimeout(() => (mounted = false), OUT_MS);
				// A reopen inside the transition keeps the dialog mounted
				return () => clearTimeout(t);
			};
		}
	});
</script>

{#if mounted}
	<div use:portal class="fixed inset-0 z-[2000]">
		<!-- BACKDROP -->
		<button
			type="button"
			tabindex="-1"
			aria-label="Close"
			class={cn(
				'absolute inset-0 cursor-default bg-[var(--overlay)] transition-opacity duration-150 motion-reduce:transition-none',
				shown ? 'opacity-100' : 'opacity-0'
			)}
			onclick={requestClose}
		></button>
		<!-- PANEL, A BOTTOM SHEET ON PHONES AND A CENTRED DIALOG FROM sm UP -->
		<div
			class={cn(
				'pointer-events-none absolute inset-0 flex items-end justify-center',
				variant === 'drawer'
					? 'sm:items-stretch sm:justify-end'
					: variant === 'top'
						? 'sm:items-start sm:p-4 sm:pt-[12vh]'
						: 'sm:items-center sm:p-4'
			)}
		>
			<div
				role="dialog"
				aria-modal="true"
				tabindex="-1"
				aria-labelledby={titleId}
				use:focusTrap
				onkeydown={onKey}
				class={cn(
					'pointer-events-auto flex max-h-[90vh] w-full flex-col overflow-hidden border border-line bg-surface text-ink shadow-[var(--shadow-pop)] transition-[opacity,translate,scale] duration-150 motion-reduce:transition-none',
					variant === 'drawer'
						? 'rounded-t-xl sm:h-full sm:max-h-none sm:max-w-[560px] sm:rounded-none sm:border-y-0 sm:border-r-0'
						: cn('rounded-t-xl sm:rounded-xl', WIDTHS[size]),
					shown
						? 'translate-y-0 opacity-100 sm:translate-x-0'
						: cn(
								'translate-y-4 opacity-0',
								variant === 'drawer' && 'sm:translate-x-8 sm:translate-y-0',
								variant === 'top' && 'sm:-translate-y-3 sm:scale-95'
							)
				)}
			>
				<div class="flex items-center gap-2 border-b border-line px-5 py-3">
					<h2 id={titleId} class="flex-1 text-lg font-semibold">
						{title}
					</h2>
					<button
						type="button"
						aria-label="Close dialog"
						disabled={busy}
						onclick={requestClose}
						class="inline-flex size-11 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
					>
						<X size={20} />
					</button>
				</div>
				<div class="min-h-0 flex-1 overflow-auto p-5 text-sm">
					{@render children()}
				</div>
				{#if footer}
					<div class="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
						{@render footer()}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
