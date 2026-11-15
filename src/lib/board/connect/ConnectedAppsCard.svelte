<script lang="ts">
	// IMPORTED DEP-MODULES
	import { enhance, type SubmitFunction } from '$app/forms';
	// IMPORTED MODULES
	import { daysLeft } from '#lib/connect/daysLeft.js';
	import { jumpTo } from '#lib/connect/jump.js';
	import { cn } from '#lib/ui/cn.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toastEnhance } from '#lib/ui/toastEnhance.js';
	// IMPORTED DEP-COMPONENTS
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
	import Plug from '@lucide/svelte/icons/plug';
	import Terminal from '@lucide/svelte/icons/terminal';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';

	// -- TYPES -- //

	type Connection = {
		id: string;
		name: string;
		kind: string;
		permissions: string[];
		expiresAt: Date | string;
		lastUsedAt: Date | string | null;
		createdAt: Date | string;
		verified: boolean | null;
		redirectHosts: string[];
		resource: string | null;
	};

	// -- REQUIRED PROPS -- //

	let {
		connections,
		orgSlug,
		orgName,
		ownAddress
	}: { connections: Connection[]; orgSlug: string; orgName: string; ownAddress: string } = $props();

	// -- CONSTANTS -- //

	const KIND_LABEL: Record<string, string> = { pat: 'Token', oauth: 'Signed in', device: 'Device' };
	const KIND_ICON = { pat: KeyRound, oauth: Plug, device: Terminal } as const;
	const NEW_MS = 10 * 60 * 1000;

	// -- STATES -- //

	const approved = new WeakSet<HTMLFormElement>();

	// -- FUNCTIONS -- //

	const when = (v: string | Date | null) =>
		v ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : 'never';

	/** A connection is revoked only after a yes: the form is held back, asked about, and sent again once approved. */
	const askFirst: SubmitFunction = ({ cancel, formElement }) => {
		if (approved.has(formElement)) {
			approved.delete(formElement);
			return;
		}
		cancel();
		void askConfirm({
			title: 'Revoke this connection?',
			body: 'The tool stops working at once. To use it again it has to connect again.',
			confirmLabel: 'Revoke'
		}).then((yes) => {
			if (yes) {
				approved.add(formElement);
				formElement.requestSubmit();
			}
		});
	};

	/** A token or a sign in made in the last ten minutes that has not been used yet. */
	const isNew = (c: Connection) =>
		!c.lastUsedAt && Date.now() - new Date(c.createdAt).getTime() < NEW_MS;
</script>

<!-- CONNECTED APPS: WHAT CAN READ AND WRITE HERE RIGHT NOW, WITH HOW LONG EACH HAS LEFT -->
<Card padded={false} data-testid="connected-apps">
	{#snippet header()}
		<span
			class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text"
			aria-hidden="true"><MonitorSmartphone size={18} /></span
		>
		<div class="min-w-0 flex-1">
			<h2 class="text-lg leading-6 font-semibold">Connected apps in {orgName}</h2>
			<p class="text-sm text-muted">Tools that can read and write here right now.</p>
		</div>
		<Badge class="tabular-nums max-sm:hidden">{connections.length} active</Badge>
	{/snippet}

	{#if connections.length === 0}
		<!-- A SHORT NOTE, NOT THE BIG PICTURE. THE CARD STAYS THE SAME SIZE AS THE ONES AROUND IT -->
		<div
			class="flex flex-wrap items-center gap-4 px-4 py-5 max-sm:px-3.5"
			data-testid="connected-empty"
		>
			<span
				class="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised text-muted"
				aria-hidden="true"><Plug size={18} /></span
			>
			<div class="min-w-48 flex-1">
				<p class="text-sm font-medium text-ink">Nothing is connected yet</p>
				<p class="text-sm text-muted">
					Tools you sign in and tokens you make appear here, and you can end any of them at once.
				</p>
			</div>
			<button
				type="button"
				class="inline-flex min-h-11 cursor-pointer items-center gap-1.5 text-sm font-medium text-accent-text hover:underline"
				onclick={() => jumpTo(document.getElementById('snippets'))}
				>Pick a tool<ArrowRight size={16} aria-hidden="true" /></button
			>
		</div>
	{:else}
		<ul class="stagger">
			{#each connections as c, i (c.id)}
				{@const left = daysLeft(c.expiresAt, c.createdAt)}
				{@const Icon = KIND_ICON[c.kind as keyof typeof KIND_ICON] ?? Plug}
				<li
					data-row
					style="--i:{i}"
					class={cn(
						'flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0 max-sm:px-3.5',
						isNew(c) && 'bg-accent-soft/40'
					)}
				>
					<div class="flex min-w-0 flex-1 items-start gap-3">
						<span
							class="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
							aria-hidden="true"><Icon size={18} /></span
						>
						<div class="flex min-w-0 flex-1 flex-col gap-1">
							<span class="flex flex-wrap items-center gap-2 font-medium text-ink">
								{c.name}
								<Badge>{KIND_LABEL[c.kind] ?? 'Device'}</Badge>
								{#if isNew(c)}<Badge tone="accent">New</Badge>{/if}
								{#if c.verified === false}<Badge tone="warning"
										>Unverified {c.redirectHosts.join(', ')}</Badge
									>{/if}
							</span>
							<span
								class="flex flex-wrap items-center gap-1"
								role="group"
								aria-label="What it may do"
							>
								{#each c.permissions as p (p)}
									<span
										class="inline-flex items-center rounded-md border border-line bg-raised px-1.5 py-0.5 font-mono text-xs text-ink"
										>{p}</span
									>
								{/each}
							</span>
							<span class="text-xs text-muted tabular-nums"
								>Can {c.permissions.join(', ')}. Last used {when(c.lastUsedAt)}. Ends {when(
									c.expiresAt
								)}.</span
							>
							<!-- THE ADDRESS IS SHOWN ONLY WHEN IT IS NOT THIS ORGANISATION'S OWN ADDRESS -->
							{#if c.kind === 'oauth' && !c.resource}
								<span class="text-xs text-muted" data-testid="connection-address"
									>Address: plain <span class="font-mono">/mcp</span></span
								>
							{:else if c.kind === 'oauth' && c.resource && c.resource !== ownAddress}
								<span class="text-xs break-all text-muted" data-testid="connection-address"
									>Address: <span class="font-mono">{c.resource}</span></span
								>
							{/if}
							{#if left}
								<span
									class={cn(
										'mt-0.5 flex items-center gap-2 text-xs tabular-nums',
										left.tone === 'warning'
											? 'text-warning'
											: left.tone === 'danger'
												? 'text-danger'
												: 'text-muted'
									)}
								>
									<span class="h-1 w-24 overflow-hidden rounded-full bg-raised" aria-hidden="true">
										<!-- THE SHARE OF ITS LIFE THAT IS LEFT IS A RUNTIME PERCENT -->
										<span
											class={cn(
												'block h-full rounded-full',
												left.tone === 'warning'
													? 'bg-warning'
													: left.tone === 'danger'
														? 'bg-danger'
														: 'bg-success'
											)}
											style="width: {left.percent}%;"
										></span>
									</span>
									{left.label}
								</span>
							{/if}
						</div>
					</div>
					<form
						method="POST"
						action="?/revoke"
						use:enhance={toastEnhance({
							id: 'revoke-connection',
							loading: 'Revoking the connection...',
							success: 'Connection revoked.',
							inline: true,
							before: askFirst
						})}
					>
						<input type="hidden" name="org" value={orgSlug} />
						<input type="hidden" name="id" value={c.id} />
						<Button type="submit" size="sm" tone="danger">Revoke</Button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</Card>
