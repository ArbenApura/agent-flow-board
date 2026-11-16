<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED DEP-MODULES
	import { invalidateAll } from '$app/navigation';
	// IMPORTED MODULES
	import { connectHref } from '#lib/connect/hrefs.js';
	import { tabStatuses } from '#lib/connect/tabStatus.js';
	import { connectionName } from '#lib/shared/orgConnection.js';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	// IMPORTED COMPONENTS
	import AgentSetupCard from '#lib/board/connect/AgentSetupCard.svelte';
	import BridgeCommandsCard from '#lib/board/connect/BridgeCommandsCard.svelte';
	import BridgeHealthCard from '#lib/board/connect/BridgeHealthCard.svelte';
	import BridgeProjectsCard from '#lib/board/connect/BridgeProjectsCard.svelte';
	import BridgeRunnerCard from '#lib/board/connect/BridgeRunnerCard.svelte';
	import ChecksApprovalsCard from '#lib/board/connect/ChecksApprovalsCard.svelte';
	import ChecksSetupCard from '#lib/board/connect/ChecksSetupCard.svelte';
	import ConnectedAppsCard from '#lib/board/connect/ConnectedAppsCard.svelte';
	import ConnectTabs from '#lib/board/connect/ConnectTabs.svelte';
	import EditorAboutCards from '#lib/board/connect/EditorAboutCards.svelte';
	import EditorLiveCard from '#lib/board/connect/EditorLiveCard.svelte';
	import EditorSetupCard from '#lib/board/connect/EditorSetupCard.svelte';
	import EditorStepsCard from '#lib/board/connect/EditorStepsCard.svelte';
	import SkillsChangelog from '#lib/board/connect/SkillsChangelog.svelte';
	import SkillsGrid from '#lib/board/connect/SkillsGrid.svelte';
	import SkillsInstallCard from '#lib/board/connect/SkillsInstallCard.svelte';
	import SnippetsCard from '#lib/board/connect/SnippetsCard.svelte';
	import TokenCard from '#lib/board/connect/TokenCard.svelte';
	import OrgTile from '#lib/board/OrgTile.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import Popover from '#lib/ui/Popover.svelte';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- STATES -- //

	let picking = $state(false);

	// -- REACTIVE STATES -- //

	const created = $derived(form && 'created' in form ? (form.created ?? null) : null);
	const message = $derived(form && 'message' in form && form.message ? String(form.message) : null);
	// Setting up the editor status has an agent sign a tool in, which needs the Manage permission
	const canSetUp = $derived((data.caps as string[]).includes('manage'));
	const org = $derived(data.org);
	// The person's own check runners, newest first. A colleague's runner is never in this list
	const mine = $derived(data.runners?.mine ?? []);
	const status = $derived(
		tabStatuses({
			connections: data.connections.length,
			skillsVersion: data.skills?.bundle.version ?? null,
			canSetUp,
			signIn: data.editor?.signIn ?? null,
			runners: data.runners ? mine : null
		})
	);
</script>

<svelte:head><title>Connect a tool</title></svelte:head>

<PageFrame class="flex flex-col gap-6 pb-12">
	<PageHeader
		title="Connect a tool"
		context="Pick the tool you work in. Once it is connected, Continue with on an item starts it. Your usual tool is set in Your settings."
		class="mb-0!"
	>
		{#snippet actions()}
			{#if data.tab !== 'skills' && org && data.orgs.length > 1}
				<!-- A TOOL CONNECTS TO ONE ORGANISATION, SO WHICH ONE IS ALWAYS SAID, WITH A MENU TO PICK ANOTHER. THE SKILLS BELONG TO NONE -->
				<div class="flex items-center gap-2" data-testid="connect-org">
					<span class="text-sm text-muted max-sm:hidden">Connecting to</span>
					<Popover bind:open={picking} placement="bottom-end" role="dialog" label="Organisation">
						{#snippet trigger({ props, toggle })}
							<Button variant="secondary" onclick={toggle} {...props}>
								<OrgTile name={org!.name} logo={org!.logo} palette={org!.palette} size={20} />
								<span class="max-w-[14rem] truncate">{org!.name}</span>
								<ChevronDown size={16} class="text-muted" />
							</Button>
						{/snippet}
						{#snippet children({ close })}
							<ul class="min-w-64 p-1">
								{#each data.orgs as o (o.id)}
									<li>
										<a
											href={connectHref(o.slug, data.tab)}
											onclick={close}
											aria-current={o.id === org!.id ? 'true' : undefined}
											class="flex min-h-10 items-center gap-2.5 rounded-md px-2.5 text-sm text-ink hover:bg-raised"
										>
											<OrgTile name={o.name} logo={o.logo} palette={o.palette} />
											<span class="truncate">{o.name}</span>
											{#if o.id === org!.id}<Check
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

	<!-- SECTIONS OF THIS PAGE, THEN THE PERSON'S OWN SETUP. THE TAB CARDS COME FIRST: WHERE YOU ARE AND WHERE YOU CAN GO -->
	<ConnectTabs tab={data.tab} org={org?.slug ?? null} {status} />

	{#if data.tab === 'skills'}
		<!-- SYSTEM SKILLS: THE FLOW SKILLS THE PRODUCT SHIPS, ONE VERSIONED BUNDLE -->
		{#if !data.skills}
			<Card padded={false} data-testid="skills-error"
				><ErrorState
					title="The skills did not load"
					message="The skills bundle could not be read on the server. Try again in a minute, or tell an administrator."
					onretry={() => invalidateAll()}
				/></Card
			>
		{:else}
			<div class="flex min-w-0 flex-col gap-6">
				<SkillsInstallCard
					bundle={data.skills.bundle}
					count={data.skills.skills.length}
					brief={data.skills.brief}
					bundleUrl={data.skills.bundleUrl}
				/>
				<SkillsGrid skills={data.skills.skills} />
				<SkillsChangelog changelog={data.skills.changelog} />
			</div>
		{/if}
	{:else if !org}
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
		<div class="grid gap-6 lg:grid-cols-3 lg:items-start">
			<Notice tone="info" class="lg:col-span-3" data-testid="editor-claude-only">
				<span class="font-medium">This only supports Claude Code.</span> The editor line shows inside
				Claude Code conversations.
			</Notice>
			<div class="stagger flex min-w-0 flex-col gap-6 lg:col-span-2">
				<EditorLiveCard
					person={data.editor?.person ?? ''}
					orgName={org.name}
					orgSlug={org.slug}
					server={data.baseUrl}
					roleLabel={ROLE_LABEL[org.role]}
					{canSetUp}
					signIn={data.editor?.signIn ?? null}
				/>
				<EditorSetupCard
					brief={data.editor?.brief ?? ''}
					{canSetUp}
					signedIn={data.editor?.signIn?.state === 'signed-in'}
					bridgeHref={connectHref(org.slug, 'bridge')}
				/>
				<EditorStepsCard />
			</div>
			<div class="stagger flex min-w-0 flex-col gap-6"><EditorAboutCards /></div>
		</div>
	{:else if data.tab === 'bridge'}
		<!-- BRIDGE: THE CHECK RUNNER, BROWSER CHECKS, WHO APPROVES WHAT AND EVERY COMMAND OF THE LOCAL BRIDGE -->
		<div class="flex min-w-0 flex-col gap-6">
			<!-- THE ROW STRETCHES, SO THE COMMANDS CARD FILLS THE LEFT COLUMN DOWN TO THE END OF THE RIGHT ONE -->
			<div class="grid gap-6 lg:grid-cols-3">
				<!-- IN THE ORDER A PERSON NEEDS IT, AND IN THE SAME ORDER FOR A KEYBOARD: WITH NO RUNNER THE CONNECT CARD COMES RIGHT AFTER THE LIVE LINE, WITH ONE WHAT IT CAN CHECK AND THE APPROVALS COME FIRST -->
				<div class="stagger flex min-w-0 flex-col gap-6 lg:col-span-2">
					<BridgeRunnerCard runner={mine[0] ?? null} orgName={org.name} />
					{#if mine[0]}
						<BridgeProjectsCard runner={mine[0]} />
						<ChecksApprovalsCard />
						<ChecksSetupCard
							brief={data.checksBrief}
							editorHref={connectHref(org.slug, 'editor')}
						/>
					{:else}
						<ChecksSetupCard
							brief={data.checksBrief}
							editorHref={connectHref(org.slug, 'editor')}
						/>
						<ChecksApprovalsCard />
					{/if}
					<!-- AT LEAST 24REM TALL, OR AS TALL AS WHAT IS LEFT OF THE COLUMN BESIDE IT. FROM lg UP THE LIST SCROLLS INSIDE -->
					<div class="lg:relative lg:min-h-96 lg:flex-1">
						<BridgeCommandsCard server={data.baseUrl} orgSlug={org.slug} orgName={org.name} />
					</div>
				</div>
				<div class="stagger flex min-w-0 flex-col gap-6">
					<BridgeHealthCard server={data.baseUrl} orgSlug={org.slug} />
				</div>
			</div>
		</div>
	{:else}
		<!-- TOOLS AND TOKENS: THE WAY IN FIRST, THEN WHAT IS CONNECTED BESIDE IT -->
		<div class="grid gap-6 lg:grid-cols-3 lg:items-start">
			<div class="stagger flex min-w-0 flex-col gap-6 lg:col-span-2">
				<AgentSetupCard setup={data.agentSetup} slug={org.slug} />
				<SnippetsCard
					snippets={data.snippets}
					orgName={org.name}
					address={data.ownAddress}
					connection={connectionName(org.slug)}
					prefix={data.prefix}
				/>
			</div>
			<aside class="stagger flex min-w-0 flex-col gap-6" aria-label="Connected apps and tokens">
				<ConnectedAppsCard
					connections={data.connections}
					orgSlug={org.slug}
					orgName={org.name}
					ownAddress={data.ownAddress}
				/>
				<TokenCard
					orgSlug={org.slug}
					orgName={org.name}
					roleLabel={ROLE_LABEL[org.role]}
					address={data.ownAddress}
					caps={data.caps as string[]}
					{created}
					{message}
				/>
			</aside>
		</div>
	{/if}
</PageFrame>
