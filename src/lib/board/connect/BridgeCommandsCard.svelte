<script lang="ts">
	// IMPORTED TYPES
	import type { CommandKind } from '#lib/connect/bridgeCommands.js';
	// IMPORTED MODULES
	import { COMMAND_KINDS, bridgeCommands, filterCommands } from '#lib/connect/bridgeCommands.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Search from '@lucide/svelte/icons/search';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	// IMPORTED COMPONENTS
	import Card from '#lib/ui/Card.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { server, orgSlug, orgName }: { server: string; orgSlug: string; orgName: string } = $props();

	// -- STATES -- //

	let term = $state('');
	let kind = $state<'All' | CommandKind>('All');

	// -- REACTIVE STATES -- //

	const all = $derived(bridgeCommands(server, orgSlug));
	const chips = $derived([
		{ key: 'All' as const, count: all.length },
		...COMMAND_KINDS.map((k) => ({ key: k, count: all.filter((c) => c.kind === k).length }))
	]);
	// The commands that match the search and the kind, grouped by kind in the usual order
	const groups = $derived(filterCommands(all, kind, term));
</script>

<!-- EVERY BRIDGE COMMAND, FILLED IN FOR THIS ORGANISATION. SEARCH AND A FILTER BY KIND, KEPT IN THE PAGE -->
<Card
	padded={false}
	data-testid="bridge-commands"
	icon={SquareTerminal}
	title="Every bridge command"
	description={`Filled in for ${orgName}. Copy one and run it in a terminal.`}
>
	<div
		class="flex flex-col gap-3 border-b border-line px-4 py-3 max-sm:px-3.5 sm:flex-row sm:items-center"
	>
		<div class="sm:w-72">
			<TextField
				label="Find a command"
				hideLabel
				icon={Search}
				type="search"
				placeholder="Find a command"
				autocomplete="off"
				bind:value={term}
			/>
		</div>
		<!-- A SIDEWAYS ROW OF CHIPS: NO SCROLLBAR, NO VERTICAL SCROLL -->
		<div
			class="-m-1 flex min-w-0 flex-1 [scrollbar-width:none]! gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain p-1 [&::-webkit-scrollbar]:hidden"
			role="radiogroup"
			aria-label="Kind of command"
		>
			{#each chips as k (k.key)}
				<button
					type="button"
					role="radio"
					aria-checked={kind === k.key}
					onclick={() => (kind = k.key)}
					class={cn(
						'inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors max-sm:min-h-11',
						kind === k.key
							? 'border-accent bg-accent-soft text-accent-text'
							: 'border-line bg-surface text-ink hover:border-muted'
					)}
				>
					{k.key}<span class="text-xs text-muted tabular-nums">{k.count}</span>
				</button>
			{/each}
		</div>
	</div>
	{#if groups.length === 0}
		<div class="flex items-center gap-4 px-4 py-5 max-sm:px-3.5">
			<span
				class="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised text-muted"
				aria-hidden="true"><Search size={18} /></span
			>
			<div>
				<p class="text-sm font-medium text-ink">No command matches</p>
				<p class="text-sm text-muted">Try another word, or choose All.</p>
			</div>
		</div>
	{:else}
		{#each groups as g (g.kind)}
			<div>
				<p
					class="px-4 pt-3 pb-1 text-xs font-medium tracking-wide whitespace-nowrap text-muted uppercase max-sm:px-3.5"
				>
					{g.kind}
				</p>
				<ul>
					{#each g.rows as c (c.command)}
						<li
							class="flex items-start gap-3 border-b border-line px-4 py-2.5 last:border-b-0 max-sm:px-3.5"
						>
							<span class="flex min-w-0 flex-1 flex-col gap-0.5">
								<code
									class="block [scrollbar-width:none]! overflow-x-auto font-mono text-xs whitespace-nowrap text-ink [&::-webkit-scrollbar]:hidden"
									>{c.command}</code
								>
								<span class="text-xs text-muted">{c.text}</span>
							</span>
							<CopyButton text={c.command} variant="icon" ariaLabel="Copy the command" />
						</li>
					{/each}
				</ul>
			</div>
		{/each}
	{/if}
</Card>
