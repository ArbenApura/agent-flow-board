<script lang="ts">
	// IMPORTED TYPES
	import type { BridgeRunner } from '#lib/server/ops/bridgeRunners.js';
	// IMPORTED DEP-COMPONENTS
	import Layers from '@lucide/svelte/icons/layers';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Card from '#lib/ui/Card.svelte';

	// -- REQUIRED PROPS -- //

	let { runner }: { runner: BridgeRunner } = $props();
</script>

<!-- WHAT IT CAN CHECK: THE REGISTRATIONS THE TOOL REPORTS, AS PLAIN NAMES -->
<Card
	padded={false}
	data-testid="runner-projects"
	icon={Layers}
	title="What it can check"
	description="The projects registered on this computer."
>
	{#if runner.registrations.length === 0}
		<div class="px-4 py-5 text-sm text-muted max-sm:px-3.5">
			Nothing is registered yet. Ask your agent to register a project folder, or run
			<span class="font-mono text-xs text-ink">agent-flow-board check project</span>.
		</div>
	{:else}
		<ul>
			{#each runner.registrations as g, i (i)}
				<li
					class="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 max-sm:px-3.5"
				>
					<div class="flex min-w-0 flex-1 flex-col gap-1">
						<span class="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
							<span class="font-mono">{g.name}</span>
							<Badge>{g.project}</Badge>
						</span>
						{#if g.repo || g.branch}
							<span class="truncate font-mono text-xs text-muted"
								>{[g.repo, g.branch].filter(Boolean).join(' · ')}</span
							>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
	<div class="border-t border-line px-4 py-3 text-xs text-muted max-sm:px-3.5">
		Something not right? <span class="font-mono text-ink">check doctor --fix</span> checks what is registered
		against the guardrails first.
	</div>
</Card>
