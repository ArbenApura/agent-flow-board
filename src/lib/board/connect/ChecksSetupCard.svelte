<script lang="ts">
	// IMPORTED DEP-COMPONENTS
	import FlaskConical from '@lucide/svelte/icons/flask-conical';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Card from '#lib/ui/Card.svelte';
	import CopyButton from '#lib/ui/CopyButton.svelte';
	import PromptPreview from '#lib/ui/PromptPreview.svelte';

	// -- REQUIRED PROPS -- //

	let { brief, editorHref }: { brief: string; editorHref: string } = $props();

	// -- CONSTANTS -- //

	const STEPS = [
		{ who: 'You', title: 'Install the bridge', text: 'Once per computer.', link: true },
		{
			who: 'You',
			title: 'Copy the prompt and paste it into your agent',
			text: 'Claude Code, or any tool that runs tools.',
			link: false
		},
		{
			who: 'Agent',
			title: 'It connects this computer',
			text: 'It runs check connect and approves the code through the board.',
			link: false
		},
		{
			who: 'Agent',
			title: 'It registers your project and runs a check',
			text: 'It asks for approval only where a folder, a site or a key is involved.',
			link: false
		}
	] as const;
</script>

<!-- RUN BROWSER CHECKS HERE: THE SAME FOUR YOU AND AGENT STEPS AS CONNECTING AN AGENT -->
<Card
	id="checks-setup"
	class="scroll-mt-[65px] md:scroll-mt-[73px]"
	data-testid="checks-setup"
	icon={FlaskConical}
	title="Run browser checks on this computer"
	description="Your agent writes the check, the bridge runs it in a sandbox here, and the pictures show on the item's Checks tab."
>
	<div class="grid gap-6 lg:grid-cols-2">
		<div class="flex min-w-0 flex-col justify-between gap-5">
			<ol class="flex flex-col" data-testid="checks-path">
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
							<span class="text-xs text-muted"
								>{s.text}{#if s.link}
									See the <a href={editorHref} class="font-medium text-accent-text hover:underline"
										>Editor status tab</a
									>.{/if}</span
							>
						</span>
					</li>
				{/each}
			</ol>
			<div class="grid grid-cols-2 gap-2 sm:flex">
				<CopyButton text={brief} label="Copy prompt" data-testid="checks-copy" />
			</div>
		</div>
		<PromptPreview text={brief} testid="checks-preview" />
	</div>
</Card>
