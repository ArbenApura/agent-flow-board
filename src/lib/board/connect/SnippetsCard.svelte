<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Component } from 'svelte';
	// IMPORTED TYPES
	import type { Snippet } from '#lib/connect/snippets.js';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import CodeXml from '@lucide/svelte/icons/code-xml';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import Plug from '@lucide/svelte/icons/plug';
	import Rocket from '@lucide/svelte/icons/rocket';
	import SquareTerminal from '@lucide/svelte/icons/square-terminal';
	// IMPORTED COMPONENTS
	import Card from '#lib/ui/Card.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';

	// -- REQUIRED PROPS -- //

	let {
		snippets,
		orgName,
		address,
		connection,
		prefix
	}: {
		snippets: Snippet[];
		orgName: string;
		/** The MCP address of this organisation. */
		address: string;
		/** The connection name, for example afb-arbenger. */
		connection: string;
		/** What the tools of this connection start with, for example mcp__afb-arbenger__. */
		prefix: string;
	} = $props();

	// -- CONSTANTS -- //

	const ICONS: Record<string, Component<{ size?: number }>> = {
		'claude-code': SquareTerminal,
		'claude-ai': MessagesSquare,
		vscode: CodeXml,
		antigravity: Rocket,
		other: Plug
	};
	const COMMANDS = /^(claude|npx|npm)\b/;

	// -- STATES -- //

	let active = $state('claude-code');

	// -- REACTIVE STATES -- //

	const snippet = $derived(snippets.find((s) => s.id === active) ?? snippets[0]);
	// The code as lines with a quiet colour: a comment is muted and the program word of a command takes the accent text
	const lines = $derived(
		snippet.code.split('\n').map((line) => {
			if (/^\s*#/.test(line)) return { kind: 'comment' as const, text: line, rest: '' };
			const m = snippet.language === 'bash' ? COMMANDS.exec(line) : null;
			return m
				? { kind: 'command' as const, text: m[0], rest: line.slice(m[0].length) }
				: { kind: 'plain' as const, text: line, rest: '' };
		})
	);
	const names = $derived([
		{ label: 'Address', value: address, aria: 'Copy the address', wide: true },
		{ label: 'Connection name', value: connection, aria: 'Copy the connection name', wide: false },
		{ label: 'Its tools start with', value: prefix, aria: 'Copy the tool prefix', wide: false }
	]);

	// -- FUNCTIONS -- //

	/** Arrow keys move between the tiles, the way a tab list does. */
	function onKey(e: KeyboardEvent) {
		const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
		if (!keys.includes(e.key)) return;
		e.preventDefault();
		// Read before the microtask: the event target is gone once the handler returns
		const list = e.currentTarget as HTMLElement;
		const i = snippets.findIndex((s) => s.id === active);
		const next =
			e.key === 'Home'
				? 0
				: e.key === 'End'
					? snippets.length - 1
					: (i + (e.key === 'ArrowRight' ? 1 : -1) + snippets.length) % snippets.length;
		active = snippets[next].id;
		queueMicrotask(() =>
			list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
		);
	}
</script>

<!-- ADD IT TO YOUR TOOL: THE THREE NAMES A PERSON NEEDS, THE TOOL, AND ITS ONE LINE -->
<Card
	id="snippets"
	class="scroll-mt-[65px] md:scroll-mt-[73px]"
	data-testid="connect-snippets"
	icon={Plug}
	title="Add it to your tool"
	description="Paste one line into the tool you use."
>
	<!-- ONE CONNECTION PER ORGANISATION, NAMED AFTER IT -->
	<p class="mb-3 text-sm" data-testid="connect-per-org">
		One connection per organisation, so name it after the organisation. This one is for {orgName}.
	</p>
	<dl
		class="grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2"
		data-testid="connect-names"
	>
		{#each names as n (n.label)}
			<div
				class={cn(
					'flex min-w-0 items-center gap-2 bg-raised px-3 py-2.5',
					n.wide && 'sm:col-span-2'
				)}
			>
				<div class="min-w-0 flex-1">
					<dt class="text-xs font-medium text-muted">{n.label}</dt>
					<dd class="truncate font-mono text-xs text-ink">{n.value}</dd>
				</div>
				<CopyButton text={n.value} variant="icon" ariaLabel={n.aria} />
			</div>
		{/each}
	</dl>
	<p class="mt-2 text-xs text-muted">
		Rule files and permission lists that name tools must use that prefix.
	</p>

	<!-- WHICH TOOL: A SMALL PICTURE OF EACH, ONE CHOSEN AT A TIME -->
	<div
		class="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5"
		role="tablist"
		aria-label="Tools"
		tabindex="-1"
		onkeydown={onKey}
	>
		{#each snippets as s, i (s.id)}
			{@const Icon = ICONS[s.id] ?? Plug}
			<button
				type="button"
				role="tab"
				id="tool-{s.id}"
				aria-selected={active === s.id}
				aria-controls="tool-panel"
				tabindex={active === s.id ? 0 : -1}
				onclick={() => (active = s.id)}
				class={cn(
					'group relative flex min-h-11 cursor-pointer flex-col items-start gap-2 rounded-lg border border-line bg-surface p-3 text-left transition-[border-color,box-shadow] duration-150 hover:border-muted aria-selected:border-accent aria-selected:ring-4 aria-selected:ring-accent-soft',
					i === snippets.length - 1 && 'max-sm:col-span-2'
				)}
			>
				<span
					class="inline-flex size-8 items-center justify-center rounded-md bg-raised text-muted transition-colors group-aria-selected:bg-accent-soft group-aria-selected:text-accent-text"
					aria-hidden="true"><Icon size={18} /></span
				>
				<span class="flex flex-col">
					<span class="text-sm font-medium text-ink">{s.label}</span>
					<span class="text-xs text-muted">{s.short}</span>
				</span>
				<span
					class="absolute top-2 right-2 inline-flex size-5 scale-0 items-center justify-center rounded-full bg-accent text-accent-ink transition-transform duration-150 group-aria-selected:scale-100 motion-reduce:transition-none"
					aria-hidden="true"><Check size={12} /></span
				>
			</button>
		{/each}
	</div>

	<!-- THE SIGN IN SENTENCE, WHERE IT GOES AND THE CODE. THE PANEL SWAPS WITH A SHORT FADE WHEN THE TOOL CHANGES -->
	<div class="mt-4" id="tool-panel" role="tabpanel" aria-labelledby="tool-{snippet.id}">
		{#key snippet.id}
			<div class="enter">
				<p class="mb-2 text-sm">{snippet.signIn}</p>
				<div class="overflow-hidden rounded-lg border border-line bg-raised">
					<div class="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
						<span
							class="rounded-md border border-line bg-raised px-1.5 py-0.5 font-mono text-xs text-muted"
							>{snippet.language}</span
						>
						<span class="min-w-0 flex-1 truncate text-xs text-muted"
							>{snippet.where ?? 'Run it in a terminal'}</span
						>
						<CopyButton text={snippet.code} size="sm" data-testid="snippet-copy" />
					</div>
					<pre
						class="overflow-x-auto p-3 font-mono text-xs leading-5 text-ink"
						data-testid="snippet-code">{#each lines as l, i (i)}{#if l.kind === 'comment'}<span
									class="text-muted">{l.text}</span
								>{:else if l.kind === 'command'}<span class="text-accent-text">{l.text}</span
								>{l.rest}{:else}{l.text}{/if}{i < lines.length - 1 ? '\n' : ''}{/each}</pre>
				</div>
			</div>
		{/key}
	</div>
</Card>
