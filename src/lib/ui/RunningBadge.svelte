<script lang="ts">
	// -- MODULES -- //
	import Badge from '#lib/ui/Badge.svelte';

	// -- REQUIRED PROPS -- //

	let {
		tool,
		title,
		phase
	}: {
		/** The agent tool, for example Claude Code. */
		tool: string;
		/** The session title, TAB_NAME: ID. */
		title?: string;
		/** A phase key makes it a phase level badge. Without one it shows the whole item as running. */
		phase?: string;
	} = $props();
</script>

<!-- ONE BADGE FOR BOTH LEVELS, PHASE AND ITEM, LIVE THROUGH THE REALTIME CHANNEL -->
<Badge tone="running">
	{phase ? `Phase ${phase}` : 'Running'}, {tool}{title ? `, ${title}` : ''}
</Badge>
