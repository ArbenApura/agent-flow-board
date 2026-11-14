<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED DEP-MODULES
	import { enhance, type SubmitFunction } from '$app/forms';
	// IMPORTED MODULES
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
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { toastEnhance } from '#lib/ui/toastEnhance.js';
	// IMPORTED DEP-COMPONENTS
	import Activity from '@lucide/svelte/icons/activity';
	import Bot from '@lucide/svelte/icons/bot';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
	import Package from '@lucide/svelte/icons/package';
	import Plug from '@lucide/svelte/icons/plug';
	import Sparkles from '@lucide/svelte/icons/sparkles';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- CONSTANTS -- //

	const uid = $props.id();

	// What the agent does on the Editor status tab, in order. The plan itself comes from the editor_status_install tool.
	const EDITOR_STEPS = [
		{
			title: 'Show you the plan',
			text: 'The hook commands and the mod files, with their checksums, before anything is written.'
		},
		{
			title: 'Sign the bridge in',
			text: 'You are the person it signs in as. It can read, comment and write here. It cannot complete, delete or manage.'
		},
		{
			title: 'Write the hooks for this repo',
			text: 'Into .claude/settings.local.json, so teammates are not changed. The old file is backed up first.'
		},
		{
			title: 'Install the editor mod',
			text: 'Into a folder Claude Code loads by itself. It asks once before writing outside the repo.'
		},
		{
			title: 'Check it works',
			text: 'Claim an item and the line shows it. A status file appears while the conversation runs and is gone after it ends.'
		}
	] as const;

	// -- STATES -- //

	let picking = $state(false);
	let previewOpen = $state(false);
	let skillsPreviewOpen = $state(false);
	let editorPreviewOpen = $state(false);
	let tabRow = $state<HTMLElement>();

	let active = $state('claude-code');
	let name = $state('');
	let days = $state('30');
	let busy = $state(false);

	// -- REACTIVE STATES -- //

	const snippet = $derived(data.snippets.find((s) => s.id === active) ?? data.snippets[0]);
	const created = $derived(form && 'created' in form ? form.created : null);
	// The tab is part of the address, and the organisation stays in it, so a link opens the same tab for the same organisation
	const tabs = $derived([
		{
			key: 'tools',
			label: 'Tools and tokens',
			href: data.org ? `/connect?org=${data.org.slug}` : '/connect'
		},
		{
			key: 'skills',
			label: 'Skills',
			href: data.org ? `/connect?org=${data.org.slug}&tab=skills` : '/connect?tab=skills'
		},
		{
			key: 'editor',
			label: 'Editor status',
			href: data.org ? `/connect?org=${data.org.slug}&tab=editor` : '/connect?tab=editor'
		}
	]);
	// Setting up the editor status has an agent sign a tool in, which needs the Manage permission
	const canSetUp = $derived((data.caps as string[]).includes('manage'));
	// The live line of the Editor status tab: one of five states, always with a plain reason
	const editorLine = $derived.by(
		(): {
			dot: string;
			tone: 'neutral' | 'success' | 'warning' | 'danger';
			badge: string;
			title: string;
			note: string;
		} => {
			const org = data.org?.name ?? 'this organisation';
			const sign = data.editor?.signIn;
			if (!canSetUp)
				return {
					dot: 'bg-muted',
					tone: 'neutral',
					badge: 'Needs Manage',
					title: `You cannot set this up in ${org}`,
					note: `Your role here is ${data.org ? ROLE_LABEL[data.org.role] : 'not set'}.`
				};
			if (!sign)
				return {
					dot: 'bg-danger',
					tone: 'danger',
					badge: 'Not read',
					title: 'Could not read who is signed in',
					note: 'Nothing was changed.'
				};
			if (sign.state === 'signed-in')
				return {
					dot: 'bg-success',
					tone: 'success',
					badge: 'Signed in',
					title: `Signed in as ${data.editor?.person} in ${org}`,
					note: `Last used ${when(sign.lastUsedAt)}. Ends ${when(sign.expiresAt)}.`
				};
			if (sign.state === 'expired')
				return {
					dot: 'bg-warning',
					tone: 'warning',
					badge: 'Expired',
					title: `The bridge sign in for ${data.editor?.person} in ${org} ended ${when(sign.expiresAt)}`,
					note: 'Paste the prompt again. The agent signs it in once more and keeps your hooks as they are.'
				};
			return {
				dot: 'bg-muted',
				tone: 'neutral',
				badge: 'Not set up',
				title: 'No bridge is signed in on your account yet',
				note: 'Copy the prompt and paste it into Claude Code. This line fills in once the agent is done.'
			};
		}
	);

	// -- REACTIVE STATEMENTS -- //

	// The active tab slides to the centre of the row on a tab change and on first load, with the row's own scroll
	$effect(() => {
		void data.tab;
		const row = tabRow;
		const current = row?.querySelector<HTMLElement>('[aria-current="page"]');
		if (!row || !current) return;
		const left =
			current.getBoundingClientRect().left -
			row.getBoundingClientRect().left +
			row.scrollLeft -
			(row.clientWidth - current.offsetWidth) / 2;
		row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
	});

	// -- FUNCTIONS -- //

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast.success('Copied');
		} catch {
			toast.warning('Copy did not work here. Select the text and copy it by hand.');
		}
	}

	/** Saves the brief as a Markdown file, made in the browser from the text already on the page. */
	function downloadSetup() {
		const url = URL.createObjectURL(new Blob([data.agentSetup], { type: 'text/markdown' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = `connect-${data.org?.slug ?? 'organisation'}.md`;
		a.click();
		URL.revokeObjectURL(url);
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

{#snippet agentPreview(
	key: string,
	text: string,
	open: boolean,
	toggle: () => void,
	testid: string
)}
	<!-- WHAT THE AGENT READS: A FULL WIDTH ROW THAT OPENS THE TEXT, THE SAME WAY THE ITEM CARDS COLLAPSE -->
	<div class="mt-3 border-t border-line pt-1" data-testid={testid}>
		<button
			type="button"
			aria-expanded={open}
			aria-controls="{uid}-{key}"
			onclick={toggle}
			class="flex min-h-11 w-full cursor-pointer items-center gap-2 text-left text-sm text-ink"
		>
			<ChevronDown
				size={16}
				class={cn(
					'shrink-0 text-muted transition-transform motion-reduce:transition-none',
					!open && '-rotate-90'
				)}
				aria-hidden="true"
			/>
			What the agent reads
		</button>
		<!-- THE TEXT OPENS AND CLOSES BY ANIMATING ITS GRID ROW BETWEEN 0 AND 1 FRACTION, LIKE THE ITEM CARDS. CLOSED, IT IS INVISIBLE AND INERT -->
		<div
			id="{uid}-{key}"
			inert={!open}
			class={cn(
				'grid transition-[grid-template-rows,visibility] duration-200 ease-out motion-reduce:transition-none',
				open ? 'grid-rows-[1fr]' : 'invisible grid-rows-[0fr]'
			)}
		>
			<div class="min-h-0 overflow-hidden">
				<pre
					class="mt-1 max-h-80 overflow-auto rounded-lg border border-line bg-raised p-3 font-mono text-xs leading-5 text-ink">{text}</pre>
			</div>
		</div>
	</div>
{/snippet}

<PageFrame class="flex flex-col gap-6 pb-12">
	<PageHeader
		title="Connect a tool"
		context="Pick the tool you work in. Once it is connected, Continue with on an item starts it. Your usual tool is set in Your settings."
		class="mb-0!"
	>
		{#snippet actions()}
			{#if data.tab === 'tools' && data.org && data.orgs.length > 1}
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

	<!-- SECTIONS OF THIS PAGE: THE TOOLS, THE SKILLS AND THE EDITOR STATUS, KEPT IN THE ADDRESS. A SIDEWAYS ROW ON A PHONE -->
	<nav
		bind:this={tabRow}
		class="flex [scrollbar-width:none]! gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-line [&::-webkit-scrollbar]:hidden"
		aria-label="Connect sections"
		data-testid="connect-tabs"
	>
		{#each tabs as t (t.key)}
			<a
				href={t.href}
				aria-current={data.tab === t.key ? 'page' : undefined}
				class={cn(
					'-mb-px inline-flex min-h-11 shrink-0 cursor-pointer items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap',
					data.tab === t.key
						? 'border-accent text-accent-text'
						: 'border-transparent text-muted hover:text-ink'
				)}>{t.label}</a
			>
		{/each}
	</nav>

	{#if data.tab === 'skills'}
		<!-- SYSTEM SKILLS: THE FLOW SKILLS THE PRODUCT SHIPS, ONE VERSIONED BUNDLE -->
		{#if !data.skills}
			<Card padded={false} data-testid="skills-error"
				><ErrorState
					title="The skills did not load"
					message="The skills bundle could not be read on the server. Try again in a minute, or tell an administrator."
				/></Card
			>
		{:else}
			<Card
				data-testid="skills-install"
				icon={Sparkles}
				title="Let your agent install the skills"
				description="Copy this, paste it into your agent. It checks what you have and asks before it changes anything you edited. An agent already connected to the board offers this by itself."
			>
				<!-- BOTH BUTTONS ARE THE SAME SIZE AND SIT ON ONE ROW, TWO ACROSS ON A PHONE -->
				<div class="grid grid-cols-2 gap-2 sm:flex" data-testid="skills-actions">
					<Button onclick={() => copy(data.skills!.brief)} data-testid="skills-copy">
						Copy install prompt
					</Button>
					<!-- THE ZIP IS A FILE, NOT A PAGE, SO THE ROUTER MUST LEAVE THE LINK ALONE -->
					<Button href={data.skills.bundleUrl} data-sveltekit-reload data-testid="skills-download"
						>Download bundle</Button
					>
				</div>
				{@render agentPreview(
					'skills-preview',
					data.skills.brief,
					skillsPreviewOpen,
					() => (skillsPreviewOpen = !skillsPreviewOpen),
					'skills-preview'
				)}
			</Card>

			<Card
				data-testid="skills-release"
				icon={Package}
				title={`Release ${data.skills.bundle.version}`}
				description={`Released ${data.skills.bundle.releasedAt}. Every skill has its own version too.`}
			>
				<ul class="flex flex-col" data-testid="skills-list">
					{#each data.skills.skills as s (s.name)}
						<li
							class="flex flex-col gap-0.5 border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0"
						>
							<span class="flex flex-wrap items-center gap-2 text-sm font-medium">
								<span class="font-mono">{s.name}</span>
								<Badge>{s.version}</Badge>
								{#if s.files > 1}<span class="text-xs font-normal text-muted">{s.files} files</span
									>{/if}
							</span>
							<span class="line-clamp-2 text-xs text-muted">{s.description}</span>
						</li>
					{/each}
				</ul>
				<!-- WHAT CHANGED: THE NEWEST RELEASES FIRST -->
				<div
					class="mt-4 flex flex-col gap-3 border-t border-line pt-4"
					data-testid="skills-changelog"
				>
					{#each data.skills.changelog as c (c.version)}
						<div>
							<p class="text-sm font-medium text-ink">
								{c.version} <span class="font-normal text-muted">{c.date}</span>
							</p>
							<ul class="mt-1 list-disc pl-5 text-sm text-muted">
								{#each c.notes as n, i (i)}<li>{n}</li>{/each}
							</ul>
						</div>
					{/each}
				</div>
				<p class="mt-4 text-xs text-muted">
					To see whether your agent is current, ask it to check what it has installed against this
					release.
				</p>
			</Card>
		{/if}
	{:else if !data.org}
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
	{:else if data.tab === 'editor'}
		<!-- EDITOR STATUS: ONE PROMPT THAT SETS UP THE LINE SHOWING THE FLOW ITEM OF A CLAUDE CODE CONVERSATION -->
		<Card
			data-testid="editor-setup"
			icon={Activity}
			title="Show your flow item in your editor"
			description="Copy this, paste it into Claude Code. The agent signs the bridge in for you, shows you what it will write and asks before it writes it. Afterwards each conversation shows the item it works on, with no token to make."
		>
			<!-- THE LIVE LINE: WHO THE BRIDGE IS SIGNED IN AS FOR THIS ORGANISATION, READ FROM THE PERSON'S OWN SIGN INS -->
			<div
				class="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-raised p-3"
				data-testid="editor-live"
				aria-live="polite"
			>
				<span class={cn('size-2 shrink-0 rounded-full', editorLine.dot)} aria-hidden="true"></span>
				<div class="min-w-48 flex-1 text-sm text-ink">
					<p>{editorLine.title}</p>
					<p class="text-xs text-muted">{editorLine.note}</p>
				</div>
				<Badge tone={editorLine.tone}>{editorLine.badge}</Badge>
			</div>
			{#if !canSetUp}
				<Notice tone="warning" class="mt-3" data-testid="editor-needs-manage">
					Setting this up needs the Manage permission in {data.org.name}, because the agent signs a
					tool in for you. Ask an owner or admin to run it, or to give you Manage.
				</Notice>
			{/if}
			{#if data.editor && !data.editor.signIn}
				<Notice tone="danger" class="mt-3" data-testid="editor-error">
					The sign ins could not be read just now. The prompt still works. Reload the page to see
					who is signed in.
				</Notice>
			{/if}
			<!-- ONE PLAIN BUTTON: CREATE TOKEN STAYS THE ONLY PRIMARY ACTION OF THE PAGE -->
			<div class="mt-4 grid grid-cols-1 gap-2 sm:flex" data-testid="editor-actions">
				<Button
					disabled={!canSetUp || !data.editor}
					onclick={() => data.editor && copy(data.editor.brief)}
					data-testid="editor-copy"
				>
					Copy setup prompt
				</Button>
			</div>
			{#if data.editor}
				{@render agentPreview(
					'editor-preview',
					data.editor.brief,
					editorPreviewOpen,
					() => (editorPreviewOpen = !editorPreviewOpen),
					'editor-preview'
				)}
			{/if}
		</Card>

		<Card
			data-testid="editor-does"
			icon={ListChecks}
			title="What the agent will do"
			description="Five steps, in this order. You can stop it at any one of them."
		>
			<ol class="flex flex-col" data-testid="editor-steps">
				{#each EDITOR_STEPS as s, i (s.title)}
					<li class="flex gap-3 border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0">
						<span
							class="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text"
							aria-hidden="true">{i + 1}</span
						>
						<span class="flex flex-col gap-0.5">
							<span class="text-sm font-medium text-ink">{s.title}</span>
							<span class="text-xs text-muted">{s.text}</span>
						</span>
					</li>
				{/each}
			</ol>
		</Card>
	{:else}
		<!-- COPY SETUP FOR YOUR AGENT -->
		<Card
			data-testid="agent-setup"
			icon={Bot}
			title="Let your agent do it"
			description="Copy this, paste it into your agent, then only approve the sign in."
		>
			<!-- BOTH BUTTONS ARE THE SAME SIZE AND SIT ON ONE ROW, TWO ACROSS ON A PHONE -->
			<div class="grid grid-cols-2 gap-2 sm:flex" data-testid="agent-setup-actions">
				<Button onclick={() => copy(data.agentSetup)} data-testid="agent-setup-copy">
					Copy setup
				</Button>
				<Button onclick={downloadSetup}>Download .md</Button>
			</div>
			{@render agentPreview(
				'preview',
				data.agentSetup,
				previewOpen,
				() => (previewOpen = !previewOpen),
				'agent-setup-preview'
			)}
		</Card>

		<Card
			data-testid="connect-snippets"
			icon={Plug}
			title="Add it to your tool"
			description="Paste one line into the tool you use."
		>
			<!-- ONE CONNECTION PER ORGANISATION, NAMED AFTER IT -->
			<p class="mb-2 text-sm" data-testid="connect-per-org">
				One connection per organisation, so name it after the organisation. This one is for {data
					.org.name}.
			</p>
			<p class="mb-3 text-xs text-muted">
				Its tools start with <span class="font-mono">{data.prefix}</span>. Rule files and permission
				lists that name tools must use that prefix.
			</p>
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
								<!-- THE ADDRESS IS SHOWN ONLY WHEN IT IS NOT THIS ORGANISATION'S OWN ADDRESS -->
								{#if c.kind === 'oauth' && !c.resource}
									<span class="text-xs text-muted" data-testid="connection-address"
										>Address: plain <span class="font-mono">/mcp</span></span
									>
								{:else if c.kind === 'oauth' && c.resource && c.resource !== data.ownAddress}
									<span class="text-xs break-all text-muted" data-testid="connection-address"
										>Address: <span class="font-mono">{c.resource}</span></span
									>
								{/if}
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
			description={`For scripts and tools that cannot sign in through a browser. It works only in ${data.org.name}.`}
		>
			<p class="mb-3 text-sm text-muted">
				The token is shown once. It lasts at most 90 days and never holds more than your role ({ROLE_LABEL[
					data.org.role
				]}) in {data.org.name} allows. Send it as a bearer header to
				<span class="font-mono text-xs break-all">{data.ownAddress}</span>.
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
