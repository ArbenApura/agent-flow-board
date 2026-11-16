<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED MODULES
	import Notice from '#lib/ui/Notice.svelte';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	import AuthShell from '#lib/ui/AuthShell.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Checkbox from '#lib/ui/Checkbox.svelte';
	import SelectField from '#lib/ui/SelectField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { LOADING_MS } from '#lib/ui/toastEnhance.js';
	// IMPORTED DEP-COMPONENTS
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';

	// -- CONSTANTS -- //

	const CAP_TEXT: Record<string, string> = {
		read: 'Read items, plans and comments',
		comment: 'Add comments',
		write: 'Create and change items and steps',
		complete: 'Mark items COMPLETED',
		delete: 'Move items to the trash',
		manage: 'Change project settings'
	};
	const VIEW_CAPS = ['read', 'comment'];
	const POLL_MS = 1500;
	// A little past the code's own 60 seconds, so a lapsed code is reported by the server first
	const GIVE_UP_MS = 75_000;

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- STATES -- //

	// The first organisation is selected on screen as well as in the form, so what is approved is what is shown
	let orgId = $state('');
	$effect(() => {
		if (!orgId) orgId = data.orgs[0]?.id ?? '';
	});
	// The page stays open when the tool takes the answer through its own address, so it follows the connection to the end
	let phase = $state<'ask' | 'waiting' | 'connected' | 'expired'>('ask');
	let toastId = $state<string | number | undefined>();

	// -- REACTIVE STATES -- //

	const org = $derived(data.orgs.find((o) => o.id === orgId) ?? data.orgs[0]);
	const caps = $derived(org ? org.caps : []);
	// Any capability outside the look group lands in the change group, so a new one is never hidden
	const groups = $derived(
		[
			{ title: 'Look and talk', caps: caps.filter((c) => VIEW_CAPS.includes(c)) },
			{ title: 'Change things', caps: caps.filter((c) => !VIEW_CAPS.includes(c)) }
		].filter((g) => g.caps.length > 0)
	);
	// The title drops the bracketed part of the name (the full name is in the warning), so it fits on one line
	const shortName = $derived((data.request?.clientName ?? '').replace(/\s*\(.*\)\s*$/, ''));
	const asked = $derived(data.request?.scopes ?? []);

	// -- FUNCTIONS -- //

	// The answer is a full page POST that ends on the tool's own address, so the toast only covers the wait
	function answering(text: string, approve = false) {
		return () => {
			// A private-scheme redirect leaves this page open, so the toast must not wait for ever
			toastId = toast.loading(text, { duration: LOADING_MS });
			if (approve) phase = 'waiting';
		};
	}

	// Asks whether the tool has redeemed the code. A failed call is ignored, so the next tick simply tries again
	async function check(): Promise<'none' | 'waiting' | 'connected' | 'expired'> {
		try {
			const q = new URLSearchParams({
				org: orgId,
				client_id: data.raw.client_id ?? '',
				code_challenge: data.raw.code_challenge ?? ''
			});
			const res = await fetch(`/oauth/authorize/status?${q}`, { cache: 'no-store' });
			if (!res.ok) return 'none';
			return ((await res.json()) as { status: 'none' | 'waiting' | 'connected' | 'expired' })
				.status;
		} catch {
			return 'none';
		}
	}

	// -- SUBSCRIPTIONS -- //

	// Polls only while an approval is in flight, and stops for good once it is connected, lapsed or given up on
	$effect(() => {
		if (phase !== 'waiting') return;
		const started = Date.now();
		let stopped = false;
		const timer = setInterval(async () => {
			const status = await check();
			if (stopped) return;
			if (status === 'connected' || status === 'expired' || Date.now() - started > GIVE_UP_MS) {
				stopped = true;
				clearInterval(timer);
				toast.dismiss(toastId);
				phase = status === 'connected' ? 'connected' : 'expired';
			}
		}, POLL_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	});
</script>

<svelte:head><title>Connect a tool</title></svelte:head>

<AuthShell title={data.request ? `Connect ${shortName}?` : 'Connection problem'}>
	{#if data.problem || !data.request}
		<Notice tone="danger" data-testid="oauth-problem">{data.problem}</Notice>
	{:else}
		<!-- WHO IS ASKING: ONE LINE, OR ONE WARNING FOR AN UNVERIFIED TOOL -->
		{#if data.request.verified}
			<p class="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted">
				<Badge tone="success">Verified</Badge>
				{data.request.clientName} returns to
				<span class="font-mono text-xs text-ink">{data.request.redirectHost}</span>
			</p>
		{:else}
			<Notice tone="warning" class="mb-3" data-testid="oauth-unverified">
				{data.request.clientName} is unverified and returns to
				<span class="font-mono text-xs">{data.request.redirectHost}</span>. Connect only a tool you
				started yourself.
			</Notice>
		{/if}
		{#if data.notice}
			<Notice tone="danger" class="mb-3" data-testid="oauth-notice">{data.notice}</Notice>
		{/if}
		{#if data.orgs.length === 0}
			<p class="text-sm">
				You are not in an organisation yet, so there is nothing to connect. Create one first.
			</p>
			<div class="mt-3">
				<Button href="/" variant="primary" class="w-full">Go to your organisations</Button>
			</div>
		{:else}
			<form
				id="consent-form"
				method="POST"
				action="/oauth/authorize/decision"
				class={['flex flex-col gap-3', phase !== 'ask' && 'hidden']}
				data-testid="consent-form"
				onsubmit={answering('Connecting...', true)}
			>
				{#each Object.entries(data.raw) as [k, v] (k)}<input
						type="hidden"
						name={k}
						value={v}
					/>{/each}
				<input type="hidden" name="org" value={org?.id ?? ''} />
				<input type="hidden" name="decision" value="approve" />
				{#if data.locked && org}
					<!-- THE ADDRESS NAMES ONE ORGANISATION, SO THERE IS NOTHING TO PICK -->
					<p class="text-sm" data-testid="oauth-org-locked">
						<span class="text-muted">Connecting to</span>
						<span class="font-medium">{org.name}</span>
						<span class="text-muted">({ROLE_LABEL[org.role]})</span>
					</p>
				{:else}
					<SelectField
						label="Organisation"
						options={data.orgs.map((o) => ({
							value: o.id,
							label: `${o.name} (${ROLE_LABEL[o.role]})`
						}))}
						bind:value={orgId}
					/>
				{/if}
				<!-- WHAT IT MAY DO: LOOKING FIRST, CHANGING SECOND, IN TIGHT ROWS -->
				<fieldset class="flex flex-col">
					<legend class="mb-1 text-xs font-medium text-muted">What it may do</legend>
					{#key org?.id}
						{#each groups as g (g.title)}
							<p class="mt-1 border-t border-line pt-2 text-xs text-muted first-of-type:border-t-0">
								{g.title}
							</p>
							{#each g.caps as c (c)}
								<Checkbox
									class="sm:min-h-8 sm:py-1"
									label={CAP_TEXT[c] ?? c}
									name="scope"
									value={c}
									checked={asked.includes(c as never)}
								/>
							{/each}
						{/each}
					{/key}
				</fieldset>
			</form>
			<!-- BOTH ANSWERS SIT ON ONE ROW. THE CONNECT BUTTON BELONGS TO THE CONSENT FORM THROUGH ITS FORM ATTRIBUTE -->
			<div class={['mt-4 flex flex-col-reverse gap-2 sm:flex-row', phase !== 'ask' && 'hidden']}>
				<form
					method="POST"
					action="/oauth/authorize/decision"
					class="sm:w-[120px]"
					onsubmit={answering('Cancelling...')}
				>
					{#each Object.entries(data.raw) as [k, v] (k)}<input
							type="hidden"
							name={k}
							value={v}
						/>{/each}
					<input type="hidden" name="decision" value="deny" />
					<Button type="submit" class="w-full">Cancel</Button>
				</form>
				<Button type="submit" form="consent-form" variant="primary" class="w-full sm:flex-1"
					>Connect</Button
				>
			</div>
			<!-- THE ANSWER ONCE SENT: WAITING FOR THE TOOL, THEN CONNECTED, OR A LAPSED CODE -->
			{#if phase !== 'ask'}
				<div
					class="flex flex-col gap-3"
					role="status"
					aria-live="polite"
					data-testid="oauth-{phase}"
				>
					{#if phase === 'waiting'}
						<p class="flex items-center gap-2 text-sm text-muted">
							<LoaderCircle size={18} class="animate-spin" aria-hidden="true" />
							Approved. Waiting for {shortName} to finish connecting...
						</p>
					{:else if phase === 'connected'}
						<p class="flex items-center gap-2 text-sm font-medium">
							<CircleCheck size={18} class="text-[var(--success)]" aria-hidden="true" />
							{shortName} is connected{org ? ` to ${org.name}` : ''}.
						</p>
						<p class="text-sm text-muted">You can close this tab and go back to {shortName}.</p>
					{:else}
						<Notice tone="warning">
							The approval ran out before {shortName} finished. Start the connection from {shortName}
							again.
						</Notice>
					{/if}
				</div>
			{/if}
		{/if}
	{/if}
</AuthShell>
