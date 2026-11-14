<script lang="ts">
	// IMPORTED MODULES
	import Badge from '#lib/ui/Badge.svelte';
	import Card from '#lib/ui/Card.svelte';
	// IMPORTED DEP-COMPONENTS
	import FileCode from '@lucide/svelte/icons/file-code';

	// -- REQUIRED PROPS -- //

	let { source }: { source: Source | null } = $props();

	// -- TYPES -- //

	type Part = { key: string; kind: string; chars: number; excludedChars: number };
	type Source = {
		version: number;
		totalChars: number;
		authoredChars: number;
		excludedChars: number;
		estimatedTokens: number;
		readCalls: number;
		bundle: boolean;
		parts: Part[];
	};

	// -- CONSTANTS -- //

	const SHOWN = 30;

	// -- REACTIVE STATES -- //

	const rows = $derived(source ? source.parts.slice(0, SHOWN) : []);
	const rest = $derived(source ? Math.max(0, source.parts.length - SHOWN) : 0);

	// -- FUNCTIONS -- //

	const n = (v: number) => v.toLocaleString('en-US');
</script>

<!-- THE COST OF READING THE SOURCE: WHAT A BUILD MUST READ, WHAT IT NEED NOT, AND THE PARTS THE PAGE IS CUT INTO -->
<Card
	title="Source"
	description="What a build reads of this version, and the parts it comes in."
	icon={FileCode}
	data-testid="mockup-source"
>
	<div class="flex flex-col gap-3">
		{#if !source}
			<p class="text-sm text-muted">The parts of this version could not be listed.</p>
		{:else}
			<p class="text-sm text-ink" data-testid="source-cost">
				<span class="font-semibold tabular-nums">{n(source.authoredChars)}</span> characters to
				read, about
				<span class="font-semibold tabular-nums">{n(source.estimatedTokens)}</span> tokens in
				<span class="font-semibold tabular-nums">{n(source.readCalls)}</span>
				{source.readCalls === 1 ? 'read' : 'reads'}.
				{#if source.excludedChars > 0}
					<span class="text-muted"
						>{n(source.excludedChars)} characters of pictures, icons and generated style need no reading.</span
					>
				{/if}
			</p>
			<p class="flex items-center gap-2 text-xs text-muted">
				<Badge tone="neutral">{source.bundle ? 'Pushed as parts' : 'Pushed as one page'}</Badge>
				{source.parts.length}
				{source.parts.length === 1 ? 'part' : 'parts'}
			</p>
			<ul class="flex flex-col divide-y divide-line text-sm" data-testid="source-parts">
				{#each rows as p (p.key)}
					<li class="flex items-baseline gap-3 py-1.5">
						<span class="min-w-0 flex-1 truncate font-mono text-xs text-ink">{p.key}</span>
						<span class="text-xs text-muted">{p.kind}</span>
						<span class="w-20 shrink-0 text-right text-xs text-ink tabular-nums">{n(p.chars)}</span>
					</li>
				{/each}
			</ul>
			{#if rest > 0}
				<p class="text-xs text-muted">and {n(rest)} more parts.</p>
			{/if}
		{/if}
	</div>
</Card>
