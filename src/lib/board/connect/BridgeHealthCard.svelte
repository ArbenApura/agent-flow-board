<script lang="ts">
	// IMPORTED MODULES
	import { BRIDGE_PROGRAM } from '#lib/connect/bridgeInstall.js';
	// IMPORTED DEP-COMPONENTS
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import HeartPulse from '@lucide/svelte/icons/heart-pulse';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Timer from '@lucide/svelte/icons/timer';
	// IMPORTED COMPONENTS
	import Card from '#lib/ui/Card.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';

	// -- CONSTANTS -- //

	const HEALTH = [
		{
			command: `${BRIDGE_PROGRAM} check status`,
			text: 'What is connected, and what needs fixing.'
		},
		{
			command: `${BRIDGE_PROGRAM} check doctor --fix`,
			text: 'Repairs the state and clears old runs.'
		},
		{ command: `${BRIDGE_PROGRAM} check clear`, text: 'Removes old runs.' },
		{ command: `${BRIDGE_PROGRAM} check setup`, text: 'Installs the browser the checks use.' },
		{
			command: `${BRIDGE_PROGRAM} check service install`,
			text: 'Windows: starts the worker when you sign in.'
		}
	] as const;
</script>

<!-- WHEN SOMETHING IS OFF: THE FIVE COMMANDS THAT REPAIR OR INSPECT THE RUNNER, EACH WITH COPY -->
<Card
	padded={false}
	data-testid="bridge-health"
	icon={HeartPulse}
	title="When something is off"
	description="Run these in a terminal."
>
	<ul>
		{#each HEALTH as h (h.command)}
			<li
				class="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0 max-sm:px-3.5"
			>
				<span class="flex min-w-0 flex-1 flex-col gap-0.5">
					<code
						class="block [scrollbar-width:none]! overflow-x-auto font-mono text-xs whitespace-nowrap text-ink [&::-webkit-scrollbar]:hidden"
						>{h.command}</code
					>
					<span class="text-xs text-muted">{h.text}</span>
				</span>
				<CopyButton text={h.command} variant="icon" ariaLabel="Copy the command" />
			</li>
		{/each}
	</ul>
</Card>

<!-- WHERE IT KEEPS THINGS: ON THIS COMPUTER, NEVER IN A REPO -->
<Card padded={false} data-testid="bridge-where" icon={HardDrive} title="Where it keeps things">
	<ul class="flex flex-col">
		<li class="flex gap-3 border-b border-line px-4 py-3 max-sm:px-3.5">
			<FolderGit2 size={16} class="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
			<span class="flex min-w-0 flex-col gap-0.5">
				<span class="text-sm font-medium text-ink">Never in a repo</span>
				<span class="text-xs text-muted">
					<span
						class="block [scrollbar-width:none]! overflow-x-auto font-mono whitespace-nowrap text-ink [&::-webkit-scrollbar]:hidden"
						>~/.agent-flow-board/checks/</span
					>Check scripts and run state. Playwright is installed there on the first run.
				</span>
			</span>
		</li>
		<li class="flex gap-3 border-b border-line px-4 py-3 max-sm:px-3.5">
			<ShieldCheck size={16} class="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
			<span class="flex min-w-0 flex-col gap-0.5">
				<span class="text-sm font-medium text-ink">A sandbox per run</span>
				<span class="text-xs text-muted"
					>A check can write only its own run folder, and never reads your saved sign ins.</span
				>
			</span>
		</li>
		<li class="flex gap-3 px-4 py-3 max-sm:px-3.5">
			<Timer size={16} class="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
			<span class="flex min-w-0 flex-col gap-0.5">
				<span class="text-sm font-medium text-ink">Stops after 40 minutes</span>
				<span class="text-xs text-muted">A run started by hand ends on its own.</span>
			</span>
		</li>
	</ul>
</Card>
