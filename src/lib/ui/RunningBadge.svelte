<script lang="ts">
	// -- TYPES -- //
	import type { WaitingBlocker } from '#lib/board/rows.js';
	// -- MODULES -- //
	import Badge from '#lib/ui/Badge.svelte';

	// -- REQUIRED PROPS -- //

	let {
		tool,
		title,
		phase,
		staleMinutes = null,
		mockupUnread = false,
		reviewIdle = false,
		waiting = null,
		age,
		compact = false
	}: {
		/** The agent tool, for example Claude Code. */
		tool: string;
		/** The session title, TAB_NAME: ID. Shown on hover, never in the badge, so the badge stays on one line. */
		title?: string;
		/** A phase key makes it a phase level badge. Without one it shows the whole item as running. */
		phase?: string;
		/** Minutes the session has left finished work unrecorded. A number adds a warning label beside the running badge. */
		staleMinutes?: number | null;
		/** The plan has a mockup the build has not read to the end. True adds a warning label beside the running badge. */
		mockupUnread?: boolean;
		/** The item is in review with nothing open and the session has gone quiet: shown as idle, not as running. */
		reviewIdle?: boolean;
		/** Waiting-for-a-person blocker on this session, shown in the warning tone (D.5). */
		waiting?: WaitingBlocker | null;
		/** When the claim started and was last seen, added to the hover text. */
		age?: string;
		/** Inside a phase heading the phase is already named, so the badge shows only the tool, working. */
		compact?: boolean;
	} = $props();

	// -- REACTIVE STATES -- //

	const text = $derived(
		reviewIdle
			? `${tool} · In review, idle`
			: phase
				? `${tool} · Phase ${phase}`
				: `${tool} · Running`
	);
	const shown = $derived(compact ? (reviewIdle ? `${tool} idle` : `${tool} working`) : text);
	const staleTitle = $derived(
		staleMinutes === null ? '' : `Work has been left unrecorded for ${staleMinutes} minutes`
	);
</script>

<!-- ONE BADGE FOR BOTH LEVELS, PHASE AND ITEM, LIVE THROUGH THE REALTIME CHANNEL. THE SESSION TITLE LIVES IN THE TOOLTIP -->
<span
	class="inline-flex max-w-full min-w-0 items-center gap-1"
	title={[title ? `${text}: ${title}` : text, age].filter(Boolean).join('. ')}
>
	<Badge
		tone={reviewIdle ? 'neutral' : 'running'}
		class={compact ? 'max-w-full min-w-0 rounded-md' : 'max-w-full min-w-0'}
	>
		<span class="truncate">{shown}</span>
	</Badge>
	<!-- A SECOND BADGE IN THE WARNING TONE, NEVER INSIDE THE RUNNING ONE AND NEVER THE ACCENT -->
	{#if staleMinutes !== null}
		<span title={staleTitle}>
			<Badge tone="warning" class={compact ? 'rounded-md' : ''}>Not recorded</Badge>
		</span>
	{/if}
	<!-- FIRST-CLASS WAITING-FOR-A-PERSON BLOCKER IN WARNING TONE (D.5) -->
	{#if waiting}
		<span title={`Waiting for a person (${waiting.kind}): ${waiting.detail}`}>
			<Badge tone="warning" class={compact ? 'rounded-md' : ''}>Waiting {waiting.kind}</Badge>
		</span>
	{/if}
	<!-- THE SAME WARNING BADGE WHEN THE PLAN'S MOCKUP IS UNREAD. AN IDLE ITEM IN REVIEW SHOWS NONE: NOTHING IS BEING BUILT -->
	{#if mockupUnread && !reviewIdle}
		<span title="Nobody has read the plan's mockup to the end yet">
			<Badge tone="warning" class={compact ? 'rounded-md' : ''}>Mockup not read</Badge>
		</span>
	{/if}
</span>
