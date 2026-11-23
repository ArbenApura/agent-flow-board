<script lang="ts">
	// IMPORTED MODULES
	import { BRIDGE_PROGRAM, INSTALL_COMMAND, NODE_REQUIREMENT } from '#lib/connect/bridgeInstall.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Activity from '@lucide/svelte/icons/activity';
	import Check from '@lucide/svelte/icons/check';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	// IMPORTED COMPONENTS
	import Card from '#lib/ui/Card.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';
	import PromptPreview from '#lib/ui/PromptPreview.svelte';
	import CommandBlock from '#lib/board/connect/CommandBlock.svelte';

	// -- REQUIRED PROPS -- //

	let {
		brief,
		canSetUp,
		signedIn,
		bridgeHref
	}: {
		/** The setup prompt, built on the server for this organisation. Empty when it could not be built. */
		brief: string;
		canSetUp: boolean;
		/** Once the bridge is signed in the moves show a check. */
		signedIn: boolean;
		/** The address of the Bridge tab, for the pointer under the install command. */
		bridgeHref: string;
	} = $props();

	// -- CONSTANTS -- //

	const NEEDS = [NODE_REQUIREMENT, 'Installed globally', 'Works for every tool you use'] as const;
</script>

{#snippet node(n: number)}
	<span
		class={cn(
			'relative inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
			signedIn ? 'bg-success-soft text-success' : 'bg-accent-soft text-accent-text'
		)}
		aria-hidden="true"
		>{#if signedIn}<Check size={14} />{:else}{n}{/if}</span
	>
{/snippet}

<!-- SHOW YOUR FLOW ITEM IN YOUR EDITOR: THREE MOVES, THE FIRST ONE IS THE BRIDGE ITSELF -->
<Card
	data-testid="editor-setup"
	icon={Activity}
	title="Show your flow item in your editor"
	description="Three moves. Afterwards each conversation shows the item it works on, with no token to make."
>
	<ol data-testid="editor-moves">
		<!-- 1. THE BRIDGE -->
		<li class="relative flex gap-4 pb-6">
			<span class="absolute top-8 bottom-0 left-[11px] w-px bg-line" aria-hidden="true"></span>
			{@render node(1)}
			<div class="min-w-0 flex-1" data-testid="bridge-install-step">
				<h3 class="text-sm font-semibold text-ink">Install the bridge</h3>
				<p class="mt-0.5 text-sm text-muted">
					One command, once per computer. It needs {NODE_REQUIREMENT}. Install it globally, because
					the hooks call it several times per tool call and a command started through npx each time
					is too slow.
				</p>
				<div class="mt-3"><CommandBlock code={INSTALL_COMMAND} testid="bridge-install" /></div>
				<ul class="mt-3 flex flex-wrap gap-2 text-xs text-muted" aria-label="Needs">
					{#each NEEDS as n (n)}
						<li
							class="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1"
						>
							<CircleCheck size={14} class="text-success" aria-hidden="true" />{n}
						</li>
					{/each}
				</ul>
				<p class="mt-3 text-sm text-muted">
					Check it: run <span class="font-mono text-xs text-ink">{BRIDGE_PROGRAM}</span> with no
					arguments. It prints its usage, and the list should include
					<span class="font-mono text-xs text-ink">setup</span>. Your agent does this check first
					and asks you before it installs anything.
				</p>
				<p class="mt-3 text-sm text-muted">
					The same bridge also publishes mockups and has more commands.
					<a href={bridgeHref} class="font-medium text-accent-text hover:underline"
						>See the Bridge tab</a
					>.
				</p>
			</div>
		</li>
		<!-- 2. THE PROMPT -->
		<li class="relative flex gap-4 pb-6">
			<span class="absolute top-8 bottom-0 left-[11px] w-px bg-line" aria-hidden="true"></span>
			{@render node(2)}
			<div class="min-w-0 flex-1">
				<h3 class="text-sm font-semibold text-ink">Paste the setup prompt into Claude Code</h3>
				<p class="mt-0.5 text-sm text-muted">
					The agent signs the bridge in for you, shows you what it will write and asks before it
					writes it.
				</p>
				<!-- ONE PLAIN BUTTON: CREATE TOKEN STAYS THE ONLY PRIMARY ACTION OF THE PAGE -->
				<div class="mt-3 grid grid-cols-1 gap-2 sm:flex" data-testid="editor-actions">
					<CopyButton
						text={brief}
						label="Copy setup prompt"
						disabled={!canSetUp || !brief}
						data-testid="editor-copy"
					/>
				</div>
				{#if brief}<PromptPreview text={brief} mode="disclosure" testid="editor-preview" />{/if}
			</div>
		</li>
		<!-- 3. RELOAD -->
		<li class="relative flex gap-4">
			{@render node(3)}
			<div class="min-w-0 flex-1">
				<h3 class="text-sm font-semibold text-ink">Reload Claude Code</h3>
				<p class="mt-0.5 text-sm text-muted">
					Run <span class="font-mono text-xs text-ink">/reload-plugins</span> or start a new conversation.
					The line shows once an item is claimed.
				</p>
			</div>
		</li>
	</ol>
</Card>
