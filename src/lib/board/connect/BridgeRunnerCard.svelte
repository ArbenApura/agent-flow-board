<script lang="ts">
	// IMPORTED TYPES
	import type { BridgeRunner } from '#lib/server/ops/bridgeRunners.js';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleDashed from '@lucide/svelte/icons/circle-dashed';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Card from '#lib/ui/Card.svelte';

	// -- REQUIRED PROPS -- //

	let {
		runner,
		orgName
	}: {
		/** The person's own newest computer in this organisation, or null when none is connected. */
		runner: BridgeRunner | null;
		orgName: string;
	} = $props();

	// -- REACTIVE STATES -- //

	const free = $derived(
		runner && runner.slots !== null ? Math.max(0, runner.slots - (runner.busy ?? 0)) : null
	);

	// -- FUNCTIONS -- //

	const when = (iso: string | null) =>
		iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : 'never';
</script>

<!-- THE CHECK RUNNER OF THIS PERSON IN THIS ORGANISATION: ON, OR NOT CONNECTED -->
<Card padded={false} data-testid="runner-live">
	<div aria-live="polite">
		<div class="flex flex-wrap items-center gap-3 p-4 max-sm:p-3.5">
			<span
				class={cn(
					'relative inline-flex size-10 shrink-0 items-center justify-center rounded-xl',
					runner
						? runner.online
							? 'bg-success-soft text-success'
							: 'bg-warning-soft text-warning'
						: 'bg-raised text-muted'
				)}
			>
				{#if runner?.online}
					<span
						class="settle-in pointer-events-none absolute inset-0 rounded-xl bg-current opacity-0"
						aria-hidden="true"
					></span>
				{/if}
				{#if runner}<CircleCheck size={20} class="relative" />{:else}<CircleDashed size={20} />{/if}
			</span>
			<div class="min-w-48 flex-1">
				{#if runner}
					<p class="text-sm font-medium text-ink">
						{runner.online
							? 'This computer runs your browser checks for'
							: 'Your computer is offline in'}
						{orgName}
					</p>
					<p class="text-xs text-muted tabular-nums">
						{runner.name} · seen {when(runner.lastSeenAt)}
					</p>
				{:else}
					<p class="text-sm font-medium text-ink">
						No computer of yours runs browser checks in {orgName} yet
					</p>
					<p class="text-xs text-muted">
						Connect this computer, and your agent can run browser checks here. Only you can use it.
					</p>
				{/if}
				<!-- THE COMPUTERS THEMSELVES ARE MANAGED IN YOUR SETTINGS, SO THERE IS ONE PLACE FOR THEM -->
				<a
					class="mt-1 inline-block cursor-pointer text-xs text-accent-text hover:underline"
					href="/settings?tab=tools">Manage your computers in Your settings</a
				>
			</div>
			<Badge tone={runner ? (runner.online ? 'success' : 'warning') : 'neutral'}
				>{runner ? (runner.online ? 'Connected' : 'Offline') : 'Not connected'}</Badge
			>
		</div>
		{#if runner}
			<dl class="grid grid-cols-3 gap-px border-t border-line bg-line text-sm max-sm:grid-cols-1">
				<div class="bg-surface px-4 py-3 max-sm:px-3.5">
					<dt class="text-xs font-medium text-muted">Run slots</dt>
					<dd class="mt-0.5 font-medium text-ink tabular-nums">
						{free === null ? 'Not reported' : `${free} free of ${runner.slots}`}
					</dd>
				</div>
				<div class="bg-surface px-4 py-3 max-sm:px-3.5">
					<dt class="text-xs font-medium text-muted">Last seen</dt>
					<dd class="mt-0.5 font-medium text-ink tabular-nums">{when(runner.lastSeenAt)}</dd>
				</div>
				<div class="bg-surface px-4 py-3 max-sm:px-3.5">
					<dt class="text-xs font-medium text-muted">Registered</dt>
					<dd class="mt-0.5 font-medium text-ink tabular-nums">
						{runner.registrations.length}
						{runner.registrations.length === 1 ? 'project' : 'projects'}
					</dd>
				</div>
			</dl>
		{/if}
	</div>
</Card>
