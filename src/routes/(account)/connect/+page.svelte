<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- DEP-MODULES -- //
	import { enhance, type SubmitFunction } from '$app/forms';
	// -- MODULES -- //
	import OrgTile from '#lib/board/OrgTile.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Checkbox from '#lib/ui/Checkbox.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { toastEnhance } from '#lib/ui/toastEnhance.js';
	// -- DEP-COMPONENTS -- //
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
	import Plug from '@lucide/svelte/icons/plug';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- STATES -- //

	let picking = $state(false);

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

<PageFrame class="flex flex-col gap-6 pb-12">
	<PageHeader
		title="Connect a tool"
		context="Pick the tool you work in. Once it is connected, Continue with on an item starts it. Your usual tool is set in Your settings."
		class="mb-0!"
	>
		{#snippet actions()}
			{#if data.org && data.orgs.length > 1}
				<!-- A TOOL CONNECTS TO ONE ORGANISATION, SO WHICH ONE IS ALWAYS SAID, WITH A MENU TO PICK ANOTHER -->
				<div class="flex items-center gap-2" data-testid="connect-org">
					<span class="text-sm text-muted max-sm:hidden">Connecting to</span>
					<Popover bind:open={picking} placement="bottom-end" role="dialog" label="Organisation">
						{#snippet trigger({ props, toggle })}
							<Button variant="secondary" onclick={toggle} {...props}>
								<OrgTile
									name={data.org!.name}
									logo={data.org!.logo}
									palette={data.org!.palette}
									size={20}
								/>
								<span class="max-w-[14rem] truncate">{data.org!.name}</span>
								<ChevronDown size={16} class="text-muted" />
							</Button>
						{/snippet}
						{#snippet children({ close })}
							<ul class="min-w-64 p-1">
								{#each data.orgs as o (o.id)}
									<li>
										<a
											href={`/connect?org=${o.slug}`}
											onclick={close}
											aria-current={o.id === data.org!.id ? 'true' : undefined}
											class="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
										>
											<OrgTile name={o.name} logo={o.logo} palette={o.palette} />
											<span class="truncate">{o.name}</span>
											{#if o.id === data.org!.id}<Check
													size={16}
													class="ml-auto shrink-0 text-accent-text"
												/>{/if}
										</a>
									</li>
								{/each}
							</ul>
						{/snippet}
					</Popover>
				</div>
			{/if}
		{/snippet}
	</PageHeader>

	{#if !data.org}
		<Card padded={false}
			><EmptyState
				kind="org"
				title="Create an organisation first"
				text="Tools connect to one organisation. Create or join one, then come back here."
			>
				{#snippet action()}<Button href="/" variant="primary">Go to your organisations</Button
					>{/snippet}
			</EmptyState></Card
		>
	{:else}
		<Card
			data-testid="connect-snippets"
			icon={Plug}
			title="Add it to your tool"
			description="Paste one line into the tool you use."
		>
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

		<Card
			padded={false}
			data-testid="connected-apps"
			icon={MonitorSmartphone}
			title={`Connected apps in ${data.org.name}`}
			description="Tools that can read and write here right now."
		>
			{#if data.connections.length === 0}
				<!-- A SHORT NOTE, NOT THE BIG PICTURE. THE CARD STAYS THE SAME SIZE AS THE ONES AROUND IT -->
				<div class="flex items-center gap-4 px-4 py-5" data-testid="connected-empty">
					<span
						class="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised text-muted"
						aria-hidden="true"><Plug size={18} /></span
					>
					<div class="min-w-0">
						<p class="text-sm font-medium text-ink">Nothing is connected yet</p>
						<p class="text-sm text-muted">
							Tools you sign in and tokens you make appear here, and you can end any of them at
							once.
						</p>
					</div>
				</div>
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
								<input type="hidden" name="org" value={data.org.slug} />
								<input type="hidden" name="id" value={c.id} />
								<Button type="submit" size="sm">Revoke</Button>
							</form>
						</li>
					{/each}
				</ul>
			{/if}
		</Card>

		<Card
			data-testid="token-form"
			icon={KeyRound}
			title="Personal access token"
			description="For scripts and tools that cannot sign in through a browser."
		>
			<p class="mb-3 text-sm text-muted">
				The token is shown once. It lasts at most 90 days and never holds more than your role ({ROLE_LABEL[
					data.org.role
				]}) allows.
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
				use:enhance={toastEnhance({
					id: 'create-token',
					loading: 'Making the token...',
					// The text is fixed on purpose: the token itself is shown once on the page, never in a toast
					success: 'Token made. Copy it now, it is shown once.',
					inline: true,
					onStart: () => (busy = true),
					onDone: () => (busy = false)
				})}
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
