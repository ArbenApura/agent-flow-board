<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- DEP-MODULES -- //
	import { enhance, type SubmitFunction } from '$app/forms';
	// -- MODULES -- //
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Checkbox from '#lib/ui/Checkbox.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Mark from '#lib/ui/Mark.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- STATES -- //

	let active = $state('claude-code');
	let name = $state('');
	let days = $state('30');
	let busy = $state(false);

	// -- REACTIVE STATES -- //

	const snippet = $derived(data.snippets.find((s) => s.id === active) ?? data.snippets[0]);
	const created = $derived(form && 'created' in form ? form.created : null);

	// -- FUNCTIONS -- //

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Copied');
		} catch {
			toast.warning('Copy did not work here. Select the text and copy it by hand.');
		}
	}

	const when = (iso: string | Date | null) =>
		iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : 'never';

	/** A connection is revoked only after a yes: the form is held back, asked about, and sent again once approved. */
	const approved = new WeakSet<HTMLFormElement>();
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
</script>

<svelte:head><title>Connect a tool</title></svelte:head>

<PageFrame tag="main" class="flex flex-col gap-6 py-8 pb-12">
	<header class="flex items-center justify-between gap-3">
		<a href="/" class="flex items-center gap-2 font-bold"><Mark size={24} /> agent-flow-board</a>
		<a href="/" class="text-sm text-accent-text hover:underline">All organisations</a>
	</header>

	<div>
		<h1 class="text-xl font-semibold tracking-tight sm:text-2xl">Connect a tool</h1>
		<p class="text-sm text-muted">
			Pick the tool you work in. Most sign you in through your browser.
		</p>
		{#if data.org && data.orgs.length > 1}
			<!-- A tool connects to one organisation, so which one is always said, with a way to pick another -->
			<p class="mt-2 text-sm" data-testid="connect-org">
				For <strong>{data.org.name}</strong>.
				{#each data.orgs.filter((o) => o.id !== data.org!.id) as o (o.id)}
					<a class="ml-2 text-accent-text hover:underline" href={`/connect?org=${o.slug}`}
						>Use {o.name} instead</a
					>
				{/each}
			</p>
		{/if}
	</div>

	{#if !data.org}
		<Card padded={false}
			><EmptyState
				title="Create an organisation first"
				text="Tools connect to one organisation. Create or join one, then come back here."
			>
				{#snippet action()}<Button href="/" variant="primary">Go to your organisations</Button
					>{/snippet}
			</EmptyState></Card
		>
	{:else}
		<Card data-testid="connect-snippets">
			{#snippet header()}<h2 class="text-lg font-semibold">Add it to your tool</h2>{/snippet}
			<div
				class="-mx-1 mb-4 flex [scrollbar-width:none]! gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-line [&::-webkit-scrollbar]:hidden"
				role="tablist"
				aria-label="Tools"
			>
				{#each data.snippets as s (s.id)}
					<button
						type="button"
						role="tab"
						aria-selected={active === s.id}
						onclick={() => (active = s.id)}
						class={cn(
							'-mb-px min-h-11 shrink-0 cursor-pointer border-b-2 px-3 text-sm font-medium whitespace-nowrap',
							active === s.id
								? 'border-accent text-accent-text'
								: 'border-transparent text-muted hover:text-ink'
						)}
					>
						{s.label}
					</button>
				{/each}
			</div>
			<p class="mb-2 text-sm">{snippet.signIn}</p>
			{#if snippet.where}<p class="mb-2 text-xs text-muted">
					Put this in {snippet.where}
				</p>{/if}
			<div class="relative rounded-lg border border-line bg-raised">
				<pre
					class="overflow-x-auto p-3 pr-20 font-mono text-xs leading-5 text-ink"
					data-testid="snippet-code">{snippet.code}</pre>
				<div class="absolute top-1.5 right-1.5">
					<Button size="sm" onclick={() => copy(snippet.code)}>Copy</Button>
				</div>
			</div>
		</Card>

		<Card padded={false} data-testid="connected-apps">
			{#snippet header()}<h2 class="text-lg font-semibold">
					Connected apps in {data.org.name}
				</h2>{/snippet}
			{#if data.connections.length === 0}
				<EmptyState
					title="Nothing is connected yet"
					text="Tools you sign in and tokens you make appear here, and you can end any of them at once."
				/>
			{:else}
				<ul>
					{#each data.connections as c (c.id)}
						<li
							data-row
							class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
						>
							<div class="flex min-w-0 flex-col">
								<span class="flex flex-wrap items-center gap-2 font-medium">
									{c.name}
									<Badge
										>{c.kind === 'pat'
											? 'Token'
											: c.kind === 'oauth'
												? 'Signed in'
												: 'Device'}</Badge
									>
									{#if c.verified === false}<Badge tone="warning"
											>Unverified {c.redirectHosts.join(', ')}</Badge
										>{/if}
								</span>
								<span class="text-xs text-muted"
									>Can {c.permissions.join(', ')}. Last used {when(c.lastUsedAt)}. Ends {when(
										c.expiresAt
									)}.</span
								>
							</div>
							<form method="POST" action="?/revoke" use:enhance={askFirst}>
								<input type="hidden" name="org" value={data.org.slug} />
								<input type="hidden" name="id" value={c.id} />
								<Button type="submit" size="sm">Revoke</Button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}
		</Card>

		<Card data-testid="token-form">
			{#snippet header()}<h2 class="text-lg font-semibold">Personal access token</h2>{/snippet}
			<p class="mb-3 text-sm text-muted">
				For scripts and tools that cannot sign in through a browser. The token is shown once. It
				lasts at most 90 days and never holds more than your role ({ROLE_LABEL[data.org.role]})
				allows.
			</p>
			{#if created}
				<div
					role="status"
					class="mb-4 rounded-lg border border-line bg-success-soft p-3"
					data-testid="token-created"
				>
					<p class="mb-2 text-sm text-success">Copy it now. It will not be shown again.</p>
					<pre
						class="mb-2 overflow-x-auto rounded-md bg-surface p-2 font-mono text-xs leading-5 break-all whitespace-pre-wrap"
						data-testid="token-value">{created.token}</pre>
					<Button size="sm" onclick={() => copy(created.token)}>Copy token</Button>
				</div>
			{/if}
			{#if form && 'message' in form && form.message}
				<Notice tone="danger" class="mb-3">{form.message}</Notice>
			{/if}
			<form
				method="POST"
				action="?/createToken"
				class="flex flex-col gap-3"
				use:enhance={() => {
					busy = true;
					return async ({ update }) => {
						await update({ reset: false });
						busy = false;
					};
				}}
			>
				<input type="hidden" name="org" value={data.org.slug} />
				<TextField
					label="What is it for?"
					name="name"
					bind:value={name}
					placeholder="CI runner"
					required
				/>
				<TextField
					label="Lasts how many days (1 to 90)"
					name="days"
					type="number"
					min="1"
					max="90"
					bind:value={days}
				/>
				<fieldset class="flex flex-col">
					<legend class="mb-1 text-xs font-medium text-muted">What it may do</legend>
					{#each data.caps as c (c)}
						<Checkbox
							label={c}
							name="permission"
							value={c}
							checked={c === 'read' || c === 'write'}
						/>
					{/each}
				</fieldset>
				<div><Button type="submit" variant="primary" loading={busy}>Create token</Button></div>
			</form>
		</Card>
	{/if}
</PageFrame>
