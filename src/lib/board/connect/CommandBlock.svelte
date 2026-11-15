<script lang="ts">
	// IMPORTED MODULES
	import { BRIDGE_PROGRAM } from '#lib/connect/bridgeInstall.js';
	// IMPORTED COMPONENTS
	import CopyButton from '#lib/ui/CopyButton.svelte';

	// -- REQUIRED PROPS -- //

	let {
		code,
		where = 'Any terminal',
		language = 'bash',
		testid
	}: {
		/** One command, copied as it is. */
		code: string;
		where?: string;
		language?: string;
		testid?: string;
	} = $props();

	// -- REACTIVE STATES -- //

	// The program word takes the accent text, the rest stays plain, so a command reads at a glance
	const program = $derived(
		[BRIDGE_PROGRAM, 'npm', 'npx'].find((p) => code === p || code.startsWith(`${p} `)) ?? ''
	);
</script>

<!-- A COMMAND IN A BOX WITH ITS LANGUAGE, WHERE TO RUN IT AND A COPY BUTTON -->
<div class="overflow-hidden rounded-lg border border-line bg-raised">
	<div class="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
		<span class="rounded-md border border-line bg-raised px-1.5 py-0.5 font-mono text-xs text-muted"
			>{language}</span
		>
		<span class="min-w-0 flex-1 truncate text-xs text-muted">{where}</span>
		<CopyButton text={code} size="sm" />
	</div>
	<pre
		class="overflow-x-auto p-3 font-mono text-xs leading-5 text-ink"
		data-testid={testid}>{#if program}<span class="text-accent-text">{program}</span>{code.slice(
				program.length
			)}{:else}{code}{/if}</pre>
</div>
