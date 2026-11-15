<script lang="ts">
	// IMPORTED DEP-COMPONENTS
	import Bot from '@lucide/svelte/icons/bot';
	import Download from '@lucide/svelte/icons/download';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';
	import PromptPreview from '#lib/ui/PromptPreview.svelte';

	// -- REQUIRED PROPS -- //

	let { setup, slug }: { setup: string; slug: string } = $props();

	// -- CONSTANTS -- //

	// Who does each step, so the only step that is the person's own is easy to see
	const STEPS = [
		{ who: 'You', title: 'Copy the setup', text: 'One block of plain text. It holds no secret.' },
		{
			who: 'You',
			title: 'Paste it into your agent',
			text: 'Claude Code, Claude chat, VS Code or any tool that runs tools.'
		},
		{
			who: 'Agent',
			title: 'It connects this organisation',
			text: 'It adds the connection, then asks you to sign in.'
		},
		{
			who: 'You',
			title: 'Approve the sign in',
			text: 'Asked once, in your browser. The only step that is yours.'
		}
	] as const;

	// -- FUNCTIONS -- //

	/** Saves the brief as a Markdown file, made in the browser from the text already on the page. */
	function downloadSetup() {
		const url = URL.createObjectURL(new Blob([setup], { type: 'text/markdown' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = `connect-${slug}.md`;
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<!-- LET YOUR AGENT DO IT: FOUR STEPS WITH WHO DOES THEM ON THE LEFT, THE TEXT THE AGENT READS ON THE RIGHT -->
<Card
	id="agent-setup"
	class="scroll-mt-[65px] md:scroll-mt-[73px]"
	data-testid="agent-setup"
	icon={Bot}
	title="Let your agent do it"
	description="Copy this, paste it into your agent, then only approve the sign in."
>
	<div class="grid gap-6 lg:grid-cols-2">
		<div class="flex min-w-0 flex-col justify-between gap-5">
			<ol class="flex flex-col" data-testid="agent-path">
				{#each STEPS as s, i (s.title)}
					<li class="relative flex gap-3 pb-5 last:pb-0">
						{#if i < STEPS.length - 1}
							<span class="absolute top-7 bottom-0 left-[11px] w-px bg-line" aria-hidden="true"
							></span>
						{/if}
						<span
							class="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text"
							aria-hidden="true">{i + 1}</span
						>
						<span class="flex min-w-0 flex-1 flex-col gap-0.5">
							<span class="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
								{s.title}
								<Badge tone={s.who === 'You' ? 'accent' : 'neutral'}>{s.who}</Badge>
							</span>
							<span class="text-xs text-muted">{s.text}</span>
						</span>
					</li>
				{/each}
			</ol>
			<!-- BOTH BUTTONS ARE THE SAME SIZE AND SIT ON ONE ROW, TWO ACROSS ON A PHONE -->
			<div class="grid grid-cols-2 gap-2 sm:flex" data-testid="agent-setup-actions">
				<CopyButton text={setup} label="Copy setup" data-testid="agent-setup-copy" />
				<Button onclick={downloadSetup}
					><Download size={16} aria-hidden="true" />Download .md</Button
				>
			</div>
		</div>
		<PromptPreview text={setup} testid="agent-setup-preview" />
	</div>
</Card>
