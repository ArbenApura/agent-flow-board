<script lang="ts">
	// -- MODULES -- //
	import Badge from '#lib/ui/Badge.svelte';

	// -- REQUIRED PROPS -- //

	let {
		tool,
		title,
		phase,
		compact = false
	}: {
		/** The agent tool, for example Claude Code. */
		tool: string;
		/** The session title, TAB_NAME: ID. Shown on hover, never in the badge, so the badge stays on one line. */
		title?: string;
		/** A phase key makes it a phase level badge. Without one it shows the whole item as running. */
		phase?: string;
		/** Inside a phase heading the phase is already named, so the badge shows only the tool, working. */
		compact?: boolean;
	} = $props();

	// -- REACTIVE STATES -- //

	const text = $derived(phase ? `${tool} · Phase ${phase}` : `${tool} · Running`);
	const shown = $derived(compact ? `${tool} working` : text);
</script>

<!-- ONE BADGE FOR BOTH LEVELS, PHASE AND ITEM, LIVE THROUGH THE REALTIME CHANNEL. THE SESSION TITLE LIVES IN THE TOOLTIP -->
<span class="inline-flex max-w-full min-w-0" title={title ? `${text}: ${title}` : text}>
	<Badge tone="running" class={compact ? 'max-w-full min-w-0 rounded-md' : 'max-w-full min-w-0'}>
		<span class="truncate">{shown}</span>
	</Badge>
</span>
