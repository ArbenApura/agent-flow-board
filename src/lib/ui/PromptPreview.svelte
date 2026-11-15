<script lang="ts">
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import FileText from '@lucide/svelte/icons/file-text';

	// -- REQUIRED PROPS -- //

	let {
		text,
		mode = 'peek',
		label = 'What the agent reads',
		testid
	}: {
		/** The text the agent reads, shown with line numbers and never run. */
		text: string;
		/** The peek always shows the first lines and opens the rest. The disclosure is closed until it is opened. */
		mode?: 'peek' | 'disclosure';
		label?: string;
		testid?: string;
	} = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();

	// -- STATES -- //

	let open = $state(false);

	// -- REACTIVE STATES -- //

	const lines = $derived(text.split('\n'));
	const bodyId = $derived(`${uid}-body`);
</script>

{#snippet code()}
	<!-- THE LINES, EACH WITH ITS NUMBER. A LONG LINE WRAPS INSTEAD OF SCROLLING SIDEWAYS -->
	<!-- The text scrolls, so a keyboard person must be able to focus it -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="font-mono text-xs leading-5 text-ink"
		role="region"
		aria-label="The text the agent reads"
		tabindex="0"
	>
		{#each lines as line, i (i)}
			<div class="flex px-3">
				<span class="w-7 shrink-0 pr-3 text-right text-muted tabular-nums select-none">{i + 1}</span
				>
				<span class="min-w-0 flex-1 break-words whitespace-pre-wrap">{line || ' '}</span>
			</div>
		{/each}
	</div>
{/snippet}

{#if mode === 'peek'}
	<!-- WHAT THE AGENT READS: THE FIRST LINES ARE ALWAYS SHOWN, THE REST OPENS WITH ONE CLICK -->
	<div class="min-w-0" data-testid={testid}>
		<div class="flex h-full flex-col overflow-hidden rounded-lg border border-line bg-raised">
			<div class="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
				<FileText size={14} class="shrink-0 text-muted" aria-hidden="true" />
				<span class="min-w-0 flex-1 truncate text-xs text-muted">{label}</span>
				<span class="text-xs text-muted tabular-nums">{lines.length} lines</span>
			</div>
			<div class="relative min-h-0 flex-1">
				<div
					id={bodyId}
					class={cn(
						'py-3 transition-[max-height] duration-200 motion-reduce:transition-none',
						open ? 'max-h-96 overflow-auto' : 'max-h-56 overflow-hidden'
					)}
				>
					{@render code()}
				</div>
				{#if !open}
					<div
						class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-raised to-transparent"
						aria-hidden="true"
					></div>
				{/if}
			</div>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={bodyId}
				onclick={() => (open = !open)}
				class="flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 border-t border-line bg-surface text-sm font-medium text-ink hover:bg-raised"
			>
				{open ? 'Show less' : `Show all ${lines.length} lines`}
				<ChevronDown
					size={16}
					class={cn(
						'text-muted transition-transform motion-reduce:transition-none',
						open && 'rotate-180'
					)}
					aria-hidden="true"
				/>
			</button>
		</div>
	</div>
{:else}
	<!-- WHAT THE AGENT READS: A FULL WIDTH ROW THAT OPENS THE TEXT, THE SAME WAY THE ITEM CARDS COLLAPSE -->
	<div class="mt-3 border-t border-line pt-1" data-testid={testid}>
		<button
			type="button"
			aria-expanded={open}
			aria-controls={bodyId}
			onclick={() => (open = !open)}
			class="flex min-h-11 w-full cursor-pointer items-center gap-2 text-left text-sm text-ink"
		>
			<ChevronDown
				size={16}
				class={cn(
					'shrink-0 text-muted transition-transform motion-reduce:transition-none',
					!open && '-rotate-90'
				)}
				aria-hidden="true"
			/>
			{label}
			<span class="ml-auto text-xs text-muted tabular-nums">{lines.length} lines</span>
		</button>
		<!-- THE TEXT OPENS AND CLOSES BY ANIMATING ITS GRID ROW BETWEEN 0 AND 1 FRACTION. CLOSED, IT IS INVISIBLE AND INERT -->
		<div
			id={bodyId}
			inert={!open}
			class={cn(
				'grid transition-[grid-template-rows,visibility] duration-200 ease-out motion-reduce:transition-none',
				open ? 'grid-rows-[1fr]' : 'invisible grid-rows-[0fr]'
			)}
		>
			<div class="min-h-0 overflow-hidden">
				<div class="mt-1 max-h-80 overflow-auto rounded-lg border border-line bg-raised py-3">
					{@render code()}
				</div>
			</div>
		</div>
	</div>
{/if}
