<script lang="ts">
	// -- MODULES -- //
	import Section from '#lib/settings/Section.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	// -- DEP-COMPONENTS -- //
	import MonitorCheck from '@lucide/svelte/icons/monitor-check';

	// -- REQUIRED PROPS -- //

	let {
		webApp,
		tools
	}: {
		webApp: boolean;
		/** The afb-checks tools that serve this project, with whether each answered lately. */
		tools: {
			id: string;
			name: string;
			online: boolean;
			slots: number | null;
			busy: number | null;
			lastSeenAt: string | null;
		}[];
	} = $props();

	// -- REACTIVE STATES -- //

	const online = $derived(tools.find((t) => t.online) ?? null);
	const lastTool = $derived(tools[0] ?? null);
</script>

{#if !webApp}
	<div
		class="rounded-xl border border-line bg-surface p-4 text-sm text-muted shadow-[var(--elev-1)]"
		data-testid="not-web-app"
	>
		Browser checks and UI shots are for web apps. Turn on "This project is a web app" in General
		first.
	</div>
{:else}
	<!-- NOTHING TO SAVE HERE: AGENTS CONNECT THE TOOL AND KEEP IT RUNNING, SO THIS SECTION ONLY SHOWS WHERE IT STANDS -->
	<Section
		id="checks-target"
		icon={MonitorCheck}
		title="Browser checks"
		text="Whether the afb-checks tool is connected. Your agents connect it and keep it running."
	>
		<!-- THE AFB-CHECKS TOOL: WHETHER IT IS CONNECTED, IN PLAIN WORDS -->
		<div class="flex flex-col gap-1.5 rounded-lg border border-line p-3" data-testid="tool-status">
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-sm font-medium">afb-checks tool</span>
				{#if online}
					<Badge tone="success">Connected</Badge>
					<span class="text-xs text-muted"
						>{online.name} answered lately.{online.slots !== null
							? ` It takes up to ${online.slots} ${online.slots === 1 ? 'run' : 'runs'} at once and holds ${online.busy ?? 0}.`
							: ''}</span
					>
				{:else if lastTool}
					<Badge tone="warning">Not running</Badge>
					<span class="text-xs text-muted"
						>{lastTool.name} last answered {lastTool.lastSeenAt
							? new Date(lastTool.lastSeenAt).toLocaleString()
							: 'never'}.</span
					>
				{:else}
					<Badge>Not connected</Badge>
				{/if}
			</div>
			<p class="text-sm text-muted">
				{#if online}
					A Run check on an item is taken by the tool on your machine, which runs the matching file
					in its checks folder.
				{:else if lastTool}
					Your agent starts it again by itself the next time a check needs to run. Nothing to do
					here.
				{:else}
					Your agent connects it by itself the next time a check needs to run. Nothing to do here.
				{/if}
			</p>
		</div>
	</Section>
{/if}
