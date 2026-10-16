<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- MODULES -- //
	import { focusTrap } from '#lib/actions/focusTrap.js';
	import { portal } from '#lib/actions/portal.js';
	import { lockScroll, unlockScroll } from '#lib/actions/scrollLock.js';
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import X from 'phosphor-svelte/lib/X';

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		title,
		children,
		footer,
		busy = false,
		size = 'md'
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
	} = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();
	const titleId = `${uid}-title`;
	const OUT_MS = 200;
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
				'absolute inset-0 cursor-default bg-[var(--overlay)] transition-opacity duration-200 motion-reduce:transition-none',
				shown ? 'opacity-100' : 'opacity-0'
			)}
			onclick={requestClose}
		></button>
		<!-- PANEL, A BOTTOM SHEET ON PHONES AND A CENTRED DIALOG FROM sm UP -->
		<div
			class="pointer-events-none absolute inset-0 flex items-end justify-center sm:items-center sm:p-4"
		>
			<div
				role="dialog"
				aria-modal="true"
				tabindex="-1"
				aria-labelledby={titleId}
				use:focusTrap
				onkeydown={onKey}
				class={cn(
					'pointer-events-auto flex max-h-[90vh] w-full flex-col overflow-hidden border border-line bg-surface text-ink shadow-[var(--shadow-pop)] transition-[opacity,transform] duration-200 motion-reduce:transition-none',
					'rounded-t-xl sm:rounded-xl',
					WIDTHS[size],
					shown ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
				)}
			>
				<div class="flex items-center gap-2 border-b border-line px-4 py-3">
					<h2
						id={titleId}
						class="flex-1 text-base leading-6 font-semibold sm:text-lg sm:leading-[26px]"
					>
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
				<div class="min-h-0 flex-1 overflow-auto p-4 text-sm leading-[22px]">
					{@render children()}
				</div>
				{#if footer}
					<div class="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
						{@render footer()}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
