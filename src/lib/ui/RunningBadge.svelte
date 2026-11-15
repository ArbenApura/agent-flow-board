<script lang="ts">
	// IMPORTED TYPES
	import type { WaitingBlocker } from '#lib/board/rows.js';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Hourglass from '@lucide/svelte/icons/hourglass';
	import PencilOff from '@lucide/svelte/icons/pencil-off';

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

	// -- CONSTANTS -- //

	// The outlined accent tile of DESIGN.md: accent at about 12 percent fill and 35 percent border, so it never shouts
	const CAPSULE_LIVE =
		'border-[color-mix(in_oklab,var(--accent)_35%,transparent)] bg-accent-soft text-accent-text';
	const CAPSULE_IDLE = 'border-line bg-raised text-muted';
	// A flag is a quiet outlined chip: ink text on the raised surface, with the warning colour only on its icon
	const FLAG =
		'inline-flex items-center gap-1.5 rounded-full border border-line bg-raised py-0.5 pr-2.5 pl-2 text-badge font-medium text-ink';

	// -- REACTIVE STATES -- //

	const text = $derived(
		reviewIdle
			? `${tool} · In review, idle`
			: phase
				? `${tool} · Phase ${phase}`
				: `${tool} · Running`
	);
	// The second segment of the capsule: the phase, or what the session is doing when the phase is already named
	const segment = $derived(
		reviewIdle
			? compact
				? 'idle'
				: 'In review, idle'
			: compact
				? 'working'
				: phase
					? `Phase ${phase}`
					: 'Running'
	);
	const staleTitle = $derived(
		staleMinutes === null ? '' : `Work has been left unrecorded for ${staleMinutes} minutes`
	);
</script>

<!-- ONE BADGE FOR BOTH LEVELS, PHASE AND ITEM, LIVE THROUGH THE REALTIME CHANNEL. THE SESSION TITLE LIVES IN THE TOOLTIP -->
<span
	class="inline-flex max-w-full min-w-0 flex-wrap items-center gap-1.5"
	title={[title ? `${text}: ${title}` : text, age].filter(Boolean).join('. ')}
>
	<!-- THE CAPSULE: A LIVE DOT AND THE TOOL, THEN A HAIRLINE AND THE PHASE -->
	<span
		data-badge
		class={cn(
			'inline-flex max-w-full min-w-0 items-stretch overflow-hidden border text-badge font-semibold',
			compact ? 'rounded-md' : 'rounded-full',
			reviewIdle ? CAPSULE_IDLE : CAPSULE_LIVE
		)}
	>
		<span class="inline-flex min-w-0 items-center gap-1.5 py-0.5 pr-2 pl-2.5">
			<!-- A SOFT RING PINGS AROUND THE DOT WHILE THE SESSION IS LIVE; AN IDLE SESSION IS A STILL DOT -->
			<span class="relative flex size-2 shrink-0" aria-hidden="true">
				{#if !reviewIdle}
					<span class="absolute inset-0 rounded-full bg-current opacity-40 motion-safe:animate-ping"
					></span>
				{/if}
				<span class={cn('relative size-2 rounded-full bg-current', reviewIdle && 'opacity-60')}
				></span>
			</span>
			<span class="truncate">{tool}</span>
		</span>
		<span
			class="inline-flex shrink-0 items-center border-l border-[color-mix(in_oklab,currentColor_25%,transparent)] px-2 py-0.5 font-medium whitespace-nowrap tabular-nums"
			>{segment}</span
		>
	</span>
	<!-- THE FLAGS ARE SEPARATE CHIPS, NEVER INSIDE THE CAPSULE AND NEVER THE ACCENT -->
	{#if staleMinutes !== null}
		<span title={staleTitle} data-badge class={cn(FLAG, compact && 'rounded-md')}>
			<PencilOff size={12} class="shrink-0 text-warning" aria-hidden="true" />Not recorded
		</span>
	{/if}
	<!-- FIRST-CLASS WAITING-FOR-A-PERSON BLOCKER (D.5) -->
	{#if waiting}
		<span
			title={`Waiting for a person (${waiting.kind}): ${waiting.detail}`}
			data-badge
			class={cn(FLAG, compact && 'rounded-md')}
		>
			<Hourglass size={12} class="shrink-0 text-warning" aria-hidden="true" />Waiting {waiting.kind}
		</span>
	{/if}
	<!-- THE SAME CHIP WHEN THE PLAN'S MOCKUP IS UNREAD. AN IDLE ITEM IN REVIEW SHOWS NONE: NOTHING IS BEING BUILT -->
	{#if mockupUnread && !reviewIdle}
		<span
			title="Nobody has read the plan's mockup to the end yet"
			data-badge
			class={cn(FLAG, compact && 'rounded-md')}
		>
			<EyeOff size={12} class="shrink-0 text-warning" aria-hidden="true" />Mockup not read
		</span>
	{/if}
</span>
