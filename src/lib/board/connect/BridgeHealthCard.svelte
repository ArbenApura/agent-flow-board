<script lang="ts">
	// IMPORTED MODULES
	import { BRIDGE_PACKAGE, BRIDGE_PROGRAM, NODE_REQUIREMENT } from '#lib/connect/bridgeInstall.js';
	// IMPORTED DEP-COMPONENTS
	import Download from '@lucide/svelte/icons/download';
	import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import HeartPulse from '@lucide/svelte/icons/heart-pulse';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Timer from '@lucide/svelte/icons/timer';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	// IMPORTED COMPONENTS
	import Card from '#lib/ui/Card.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';

	// -- REQUIRED PROPS -- //

	let { server, orgSlug }: { server: string; orgSlug: string } = $props();

	// -- CONSTANTS -- //

	// What a person runs when something is off, in the order to try them
	const HEALTH = [
		{
			command: `${BRIDGE_PROGRAM} check doctor`,
			text: 'Checks everything and lists each line as OK, Missing or Wrong, with the command that fixes it. A healthy computer ends with "Nothing is wrong."'
		},
		{
			command: `${BRIDGE_PROGRAM} check doctor --fix --yes`,
			text: 'Repairs what it can. If the browser is missing it downloads it once (about 320 MB); --yes is your yes to that.'
		},
		{
			command: `${BRIDGE_PROGRAM} check status`,
			text: 'What is connected, and what needs fixing.'
		},
		{ command: `${BRIDGE_PROGRAM} check clear`, text: 'Removes old runs.' },
		{
			command: `${BRIDGE_PROGRAM} check service install`,
			text: 'Windows: starts the worker when you sign in.'
		}
	] as const;

	// -- REACTIVE STATES -- //

	// The board address and the organisation fill the disconnect line, so it can be copied as it is
	const removal = $derived([
		{
			command: `${BRIDGE_PROGRAM} check disconnect --server ${server} --org ${orgSlug}`,
			text: 'Disconnect this computer from this organisation.'
		},
		{
			command: `${BRIDGE_PROGRAM} check service uninstall`,
			text: 'Windows only: stop the worker that starts when you sign in.'
		},
		{ command: `npm uninstall -g ${BRIDGE_PACKAGE}`, text: 'Remove the program.' },
		{
			command:
				'Remove-Item -Recurse -Force "$HOME\\.agent-flow-board\\checks\\browsers", "$HOME\\.agent-flow-board\\checks\\runtime"',
			text: 'Windows (PowerShell): delete the browser and the browser tools. Your scripts stay.'
		},
		{
			command: 'rm -rf ~/.agent-flow-board/checks/browsers ~/.agent-flow-board/checks/runtime',
			text: 'macOS and Linux: delete the browser and the browser tools. Your scripts stay.'
		}
	]);
</script>

<!-- WHAT IT NEEDS: WHAT YOU INSTALL FIRST AND WHAT THE BRIDGE DOWNLOADS FOR YOU -->
<Card
	padded={false}
	data-testid="bridge-needs"
	icon={Download}
	title="What it needs"
	description="Only Node comes from you. The bridge fetches the rest the first time you set it up."
>
	<ul class="flex flex-col">
		<li class="flex gap-3 border-b border-line px-4 py-3 max-sm:px-3.5">
			<span class="flex min-w-0 flex-col gap-0.5">
				<span class="text-sm font-medium text-ink">Node comes first</span>
				<span class="text-xs text-muted"
					>{NODE_REQUIREMENT}, from nodejs.org. The bridge cannot install it.</span
				>
			</span>
		</li>
		<li class="flex gap-3 border-b border-line px-4 py-3 max-sm:px-3.5">
			<span class="flex min-w-0 flex-col gap-0.5">
				<span class="text-sm font-medium text-ink">The bridge, once per computer</span>
				<span
					class="block [scrollbar-width:none]! overflow-x-auto font-mono text-xs whitespace-nowrap text-ink [&::-webkit-scrollbar]:hidden"
					>npm install -g {BRIDGE_PACKAGE}</span
				>
				<span class="text-xs text-muted">It is small and downloads nothing else by itself.</span>
			</span>
		</li>
		<li class="flex gap-3 px-4 py-3 max-sm:px-3.5">
			<span class="flex min-w-0 flex-col gap-0.5">
				<span class="text-sm font-medium text-ink">A browser, about 320 MB, once</span>
				<span class="text-xs text-muted"
					>Setting it up tells you the size and waits for your yes (--yes). It goes to a folder of
					the bridge's own, so a browser from another project is never touched. On Linux you may
					also need system libraries; setup names them if they are missing.</span
				>
			</span>
		</li>
	</ul>
</Card>

<!-- WHEN SOMETHING IS OFF: THE COMMANDS THAT REPAIR OR INSPECT THE RUNNER, EACH WITH COPY -->
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
					>Check scripts and run state. The browser tools and the browser are in the folders
					<span class="font-mono text-ink">runtime</span> and
					<span class="font-mono text-ink">browsers</span> inside it.
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

<!-- REMOVE IT: DISCONNECT, REMOVE THE WORKER, THE PROGRAM AND ONLY THE BRIDGE'S OWN FOLDERS -->
<Card
	padded={false}
	data-testid="bridge-remove"
	icon={Trash2}
	title="Remove it"
	description="In this order. Each line is for one thing and touches only the bridge's own files."
>
	<ul>
		{#each removal as r (r.command)}
			<li
				class="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0 max-sm:px-3.5"
			>
				<span class="flex min-w-0 flex-1 flex-col gap-0.5">
					<code
						class="block [scrollbar-width:none]! overflow-x-auto font-mono text-xs whitespace-nowrap text-ink [&::-webkit-scrollbar]:hidden"
						>{r.command}</code
					>
					<span class="text-xs text-muted">{r.text}</span>
				</span>
				<CopyButton text={r.command} variant="icon" ariaLabel="Copy the command" />
			</li>
		{/each}
	</ul>
</Card>
