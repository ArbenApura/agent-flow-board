<script lang="ts">
	// IMPORTED MODULES
	import { jumpTo } from '#lib/connect/jump.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Bot from '@lucide/svelte/icons/bot';
	import Compass from '@lucide/svelte/icons/compass';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import Plug from '@lucide/svelte/icons/plug';
	// IMPORTED COMPONENTS
	import Card from '#lib/ui/Card.svelte';

	// -- CONSTANTS -- //

	const OPTIONS = [
		{
			target: 'agent-setup',
			icon: Bot,
			title: 'I want it done for me',
			text: 'Let your agent do it. You only approve the sign in.'
		},
		{
			target: 'snippets',
			icon: Plug,
			title: 'I sit in front of the tool',
			text: 'Add it to your tool. It signs in through your browser.'
		},
		{
			target: 'token',
			icon: KeyRound,
			title: 'It is a script or a CI job',
			text: 'Make a personal access token. No browser needed.'
		}
	] as const;

	// -- STATES -- //

	/** The way the person chose, kept marked until they choose another. */
	let chosen = $state<string | null>(null);

	// -- FUNCTIONS -- //

	function go(e: MouseEvent, target: string) {
		e.preventDefault();
		chosen = target;
		jumpTo(document.getElementById(target));
	}
</script>

<!-- WHICH ONE DO I NEED: THE CHOICE COMES FIRST, SO IT SITS AT THE TOP, ALSO ON A PHONE. EACH OPTION SCROLLS TO ITS CARD AND STAYS MARKED -->
<Card padded={false} data-testid="which-one" icon={Compass} title="Which one do I need?">
	<ul class="grid gap-1 p-1.5 sm:grid-cols-3">
		{#each OPTIONS as o (o.target)}
			{@const Icon = o.icon}
			<li>
				<a
					href="#{o.target}"
					aria-current={chosen === o.target ? 'true' : undefined}
					onclick={(e) => go(e, o.target)}
					class={cn(
						'flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-transparent p-2.5 transition-colors hover:bg-raised',
						'aria-[current=true]:border-accent aria-[current=true]:bg-accent-soft/50'
					)}
				>
					<span class="mt-0.5 text-accent-text" aria-hidden="true"><Icon size={16} /></span>
					<span class="flex min-w-0 flex-col">
						<span class="text-sm font-medium text-ink">{o.title}</span>
						<span class="text-xs text-muted">{o.text}</span>
					</span>
				</a>
			</li>
		{/each}
	</ul>
</Card>
