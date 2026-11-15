<script lang="ts">
	// IMPORTED DEP-COMPONENTS
	import ListChecks from '@lucide/svelte/icons/list-checks';
	// IMPORTED COMPONENTS
	import Card from '#lib/ui/Card.svelte';

	// -- CONSTANTS -- //

	// What the agent does on the Editor status tab, in order. The plan itself comes from the editor_status_install tool.
	const EDITOR_STEPS = [
		{
			title: 'Check the bridge',
			text: 'It runs agent-flow-board with no arguments. If the command is missing it asks once before it installs it.'
		},
		{
			title: 'Show you the plan',
			text: 'The hook commands and the mod files, with their checksums, before anything is written.'
		},
		{
			title: 'Sign the bridge in',
			text: 'You are the person it signs in as. It can read, comment and write here. It cannot complete, delete or manage.'
		},
		{
			title: 'Write the hooks for this repo',
			text: 'Into .claude/settings.local.json, so teammates are not changed. The old file is backed up first.'
		},
		{
			title: 'Install the editor mod',
			text: 'Into a folder Claude Code loads by itself. It asks once before writing outside the repo.'
		},
		{
			title: 'Check it works',
			text: 'Claim an item and the line shows it. A status file appears while the conversation runs and is gone after it ends.'
		}
	] as const;
</script>

<!-- WHAT THE AGENT WILL DO: SIX STEPS, IN ORDER, THE PERSON CAN STOP IT AT ANY ONE -->
<Card
	data-testid="editor-does"
	icon={ListChecks}
	title="What the agent will do"
	description="Six steps, in this order. You can stop it at any one of them."
>
	<ol class="flex flex-col" data-testid="editor-steps">
		{#each EDITOR_STEPS as s, i (s.title)}
			<li class="flex gap-3 border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0">
				<span
					class="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text"
					aria-hidden="true">{i + 1}</span
				>
				<span class="flex flex-col gap-0.5">
					<span class="text-sm font-medium text-ink">{s.title}</span>
					<span class="text-xs text-muted">{s.text}</span>
				</span>
			</li>
		{/each}
	</ol>
</Card>
