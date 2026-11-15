<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Component } from 'svelte';
	// IMPORTED MODULES
	import { loginCommand } from '#lib/connect/bridgeInstall.js';
	import { daysLeft } from '#lib/connect/daysLeft.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleDashed from '@lucide/svelte/icons/circle-dashed';
	import Clock from '@lucide/svelte/icons/clock';
	import Lock from '@lucide/svelte/icons/lock';
	import Terminal from '@lucide/svelte/icons/terminal';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import CommandBlock from '#lib/board/connect/CommandBlock.svelte';

	// -- TYPES -- //

	type Tone = 'neutral' | 'success' | 'warning' | 'danger';
	type SignIn = {
		state: 'signed-in' | 'expired' | 'none';
		lastUsedAt: string | null;
		expiresAt: string | null;
	};

	// -- REQUIRED PROPS -- //

	let {
		person,
		orgName,
		orgSlug,
		server,
		roleLabel,
		canSetUp,
		signIn
	}: {
		person: string;
		orgName: string;
		orgSlug: string;
		/** The board address, for the plain login command. */
		server: string;
		roleLabel: string;
		/** Setting this up has an agent sign a tool in, which needs the Manage permission. */
		canSetUp: boolean;
		/** Null when the sign ins could not be read. */
		signIn: SignIn | null;
	} = $props();

	// -- CONSTANTS -- //

	const TILE: Record<Tone, string> = {
		neutral: 'bg-raised text-muted',
		success: 'bg-success-soft text-success',
		warning: 'bg-warning-soft text-warning',
		danger: 'bg-danger-soft text-danger'
	};
	const BAR: Record<Tone, string> = {
		neutral: 'bg-muted',
		success: 'bg-success',
		warning: 'bg-warning',
		danger: 'bg-danger'
	};

	// -- REACTIVE STATES -- //

	// The live line of the Editor status tab: one of five states, always with a plain reason
	const line = $derived.by(
		(): {
			tone: Tone;
			icon: Component<{ size?: number; class?: string }>;
			badge: string;
			title: string;
			note: string;
			/** Whether the plain login command is offered (it needs Manage, so never when that is missing). */
			byHand: boolean;
		} => {
			if (!canSetUp)
				return {
					tone: 'neutral',
					icon: Lock,
					badge: 'Needs Manage',
					title: `You cannot set this up in ${orgName}`,
					note: `Your role here is ${roleLabel}.`,
					byHand: false
				};
			if (!signIn)
				return {
					tone: 'danger',
					icon: CircleAlert,
					badge: 'Not read',
					title: 'Could not read who is signed in',
					note: 'Nothing was changed.',
					byHand: true
				};
			if (signIn.state === 'signed-in')
				return {
					tone: 'success',
					icon: CircleCheck,
					badge: 'Signed in',
					title: `Signed in as ${person} in ${orgName}`,
					note: `Last used ${when(signIn.lastUsedAt)}. Ends ${when(signIn.expiresAt)}.`,
					byHand: false
				};
			if (signIn.state === 'expired')
				return {
					tone: 'warning',
					icon: Clock,
					badge: 'Expired',
					title: `The bridge sign in for ${person} in ${orgName} ended ${when(signIn.expiresAt)}`,
					note: 'Paste the prompt again. The agent signs it in once more and keeps your hooks as they are.',
					byHand: true
				};
			return {
				tone: 'neutral',
				icon: CircleDashed,
				badge: 'Not set up',
				title: 'No bridge is signed in on your account yet',
				note: 'Copy the prompt and paste it into Claude Code. This line fills in once the agent is done.',
				byHand: true
			};
		}
	);
	// A bar of the days the sign in has left, for a sign in that is there or has just ended
	const left = $derived(
		canSetUp && signIn && signIn.state !== 'none' ? daysLeft(signIn.expiresAt, null) : null
	);
	const Icon = $derived(line.icon);

	// -- FUNCTIONS -- //

	const when = (iso: string | null) =>
		iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : 'never';
</script>

<!-- THE LIVE LINE: WHO THE BRIDGE IS SIGNED IN AS FOR THIS ORGANISATION, READ FROM THE PERSON'S OWN SIGN INS -->
<Card padded={false} data-testid="editor-live">
	<div aria-live="polite">
		<div class="flex flex-wrap items-center gap-3 p-4 max-sm:p-3.5">
			<span
				class={cn(
					'relative inline-flex size-10 shrink-0 items-center justify-center rounded-xl',
					TILE[line.tone]
				)}
			>
				<!-- A SOFT RING SETTLES ONCE AROUND A SIGN IN THAT IS GOOD. IT NEVER LOOPS -->
				{#if line.tone === 'success'}
					<span
						class="settle-in pointer-events-none absolute inset-0 rounded-xl bg-current opacity-0"
						aria-hidden="true"
					></span>
				{/if}
				<Icon size={20} class="relative" />
			</span>
			<div class="min-w-48 flex-1 text-sm text-ink">
				<p class="font-medium">{line.title}</p>
				<p class="text-xs text-muted">{line.note}</p>
			</div>
			<Badge tone={line.tone}>{line.badge}</Badge>
		</div>
		{#if left}
			<div class="border-t border-line px-4 py-3 max-sm:px-3.5">
				<div class="flex items-center justify-between gap-3 text-xs">
					<span class="font-medium text-ink">Sign in lasts</span>
					<span class="text-muted tabular-nums">{left.label}</span>
				</div>
				<div
					class="mt-2 h-1.5 overflow-hidden rounded-full bg-raised"
					role="progressbar"
					aria-label="Share of the sign in that is left"
					aria-valuemin="0"
					aria-valuemax="100"
					aria-valuenow={left.percent}
				>
					<!-- THE SHARE LEFT IS A RUNTIME PERCENT -->
					<div
						class={cn(
							'fill-in h-full rounded-full',
							BAR[left.tone === 'danger' ? 'warning' : left.tone]
						)}
						style="width: {left.percent}%;"
					></div>
				</div>
			</div>
		{/if}
	</div>
	{#if !canSetUp}
		<div class="border-t border-line p-4 max-sm:p-3.5">
			<Notice tone="warning" data-testid="editor-needs-manage">
				Setting this up needs the Manage permission in {orgName}, because the agent signs a tool in
				for you. Ask an owner or admin to run it, or to give you Manage.
			</Notice>
		</div>
	{:else if !signIn}
		<div class="border-t border-line p-4 max-sm:p-3.5">
			<Notice tone="danger" data-testid="editor-error">
				The sign ins could not be read just now. The prompt still works. Reload the page to see who
				is signed in.
			</Notice>
		</div>
	{/if}
	{#if line.byHand}
		<!-- THE PLAIN COMMAND, FOR WHEN THE AGENT ROUTE IS NOT WANTED. THIS SIGN IN IS ITS OWN, APART FROM THE MCP CONNECTION -->
		<div class="border-t border-line p-4 max-sm:p-3.5" data-testid="editor-by-hand">
			<p class="flex items-center gap-2 text-sm font-medium text-ink">
				<Terminal size={16} class="shrink-0 text-muted" aria-hidden="true" />Prefer to sign in
				yourself?
			</p>
			<p class="mt-0.5 mb-3 text-xs text-muted">
				Run this in a terminal and approve the code in your browser. This sign in is separate from
				the MCP connection: signing the MCP in again does not renew it.
			</p>
			<CommandBlock code={loginCommand(server, orgSlug)} testid="bridge-login" />
		</div>
	{/if}
</Card>
