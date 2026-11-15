<script lang="ts">
	// IMPORTED DEP-COMPONENTS
	import FileText from '@lucide/svelte/icons/file-text';
	import History from '@lucide/svelte/icons/history';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Terminal from '@lucide/svelte/icons/terminal';
	// IMPORTED COMPONENTS
	import Card from '#lib/ui/Card.svelte';
</script>

<!-- WHAT YOU WILL SEE: A SKETCH OF THE LINE, WITH GENERIC WORDS -->
<Card
	data-testid="editor-sketch"
	icon={Terminal}
	title="What you will see"
	description="A sketch of the line."
>
	<div class="overflow-hidden rounded-lg border border-line bg-raised">
		<div class="flex items-center gap-2 px-3 py-2 font-mono text-xs text-ink">
			<span class="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true"></span>
			<span class="truncate">PRJ-20261115-0905</span>
			<span class="text-muted">·</span>
			<span class="truncate text-muted">step 2 of 5</span>
		</div>
	</div>
	<p class="mt-3 text-xs text-muted">
		The line shows under your conversation once an item is claimed. It names the item the
		conversation works on and nothing else.
	</p>
</Card>

<!-- WHAT LANDS ON YOUR COMPUTER: THE THREE THINGS THE BRIDGE WRITES, FROM ITS README -->
<Card
	padded={false}
	data-testid="editor-writes"
	icon={ShieldCheck}
	title="What lands on your computer"
	description="Nothing here holds a token you can lose."
>
	<ul class="flex flex-col">
		<li class="flex gap-3 border-b border-line px-4 py-3 max-sm:px-3.5">
			<KeyRound size={16} class="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
			<span class="flex min-w-0 flex-col gap-0.5">
				<span class="text-sm font-medium text-ink">Your sign in</span>
				<span class="text-xs text-muted"
					>In your operating system keychain, one entry per server and organisation.</span
				>
			</span>
		</li>
		<li class="flex gap-3 border-b border-line px-4 py-3 max-sm:px-3.5">
			<FileText size={16} class="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
			<span class="flex min-w-0 flex-col gap-0.5">
				<span class="text-sm font-medium text-ink">A status file</span>
				<span class="text-xs text-muted">
					<span
						class="block [scrollbar-width:none]! overflow-x-auto font-mono whitespace-nowrap text-ink [&::-webkit-scrollbar]:hidden"
						>~/.agent-flow-board/status/&lt;conversation&gt;.json</span
					>No token in it, and it is removed when the conversation ends.
				</span>
			</span>
		</li>
		<li class="flex gap-3 px-4 py-3 max-sm:px-3.5">
			<History size={16} class="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
			<span class="flex min-w-0 flex-col gap-0.5">
				<span class="text-sm font-medium text-ink">Backups</span>
				<span class="text-xs text-muted">
					<span
						class="block [scrollbar-width:none]! overflow-x-auto font-mono whitespace-nowrap text-ink [&::-webkit-scrollbar]:hidden"
						>~/.agent-flow-board/backups/</span
					>A copy of any settings file the setup changed.
				</span>
			</span>
		</li>
	</ul>
</Card>
