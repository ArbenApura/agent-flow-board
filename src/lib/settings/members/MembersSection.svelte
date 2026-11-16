<script lang="ts">
	// IMPORTED TYPES
	import type { Role } from '#lib/shared/roles.js';
	import type {
		InviteView,
		MemberView,
		ProjectRoleView,
		ProjectView,
		RoleFilter
	} from './memberModel.js';
	// IMPORTED CONSTANTS
	import { accessSummary } from './memberModel.js';
	import { ROLE_LABEL, ROLES } from '#lib/shared/roles.js';
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { cn } from '#lib/ui/cn.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import Info from '@lucide/svelte/icons/info';
	import Search from '@lucide/svelte/icons/search';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import Users from '@lucide/svelte/icons/users';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import InvitationsList from './InvitationsList.svelte';
	import InviteModal from './InviteModal.svelte';
	import MemberRow from './MemberRow.svelte';
	import ProjectAccessDrawer from './ProjectAccessDrawer.svelte';
	import RoleGuide from './RoleGuide.svelte';
	import Section from '#lib/settings/Section.svelte';
	import TableHead from './TableHead.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let {
		org,
		viewerRole,
		viewerId,
		canManage,
		allowGuests,
		members,
		invites,
		projects,
		projectRoles,
		onchange
	}: {
		/** The organisation address, for the members and invitations API. */
		org: string;
		/** The role of the person looking. It decides what the list lets them do. */
		viewerRole: Role;
		viewerId: string;
		canManage: boolean;
		/** The organisation setting that lets guests be invited at all. */
		allowGuests: boolean;
		members: MemberView[];
		invites: InviteView[];
		projects: ProjectView[];
		projectRoles: ProjectRoleView[];
		/** Reads the page data again after a change. */
		onchange: () => void | Promise<void>;
	} = $props();

	// -- STATES -- //

	let tab = $state<'members' | 'invitations'>('members');
	let filter = $state<RoleFilter>('all');
	let query = $state('');
	let inviteOpen = $state(false);
	let guideOpen = $state(false);
	let accessOpen = $state(false);
	/** Kept after the drawer closes, so its content does not flash blank during the transition. */
	let accessId = $state<string | null>(null);
	/** The person whose role just changed, so their row tints for a moment. */
	let flashId = $state<string | null>(null);
	let flashTimer: ReturnType<typeof setTimeout> | undefined;
	let tabRow = $state<HTMLElement>();

	// -- REACTIVE STATES -- //

	const counts = $derived.by(() => {
		const n: Record<RoleFilter, number> = {
			all: members.length,
			owner: 0,
			admin: 0,
			member: 0,
			viewer: 0,
			guest: 0
		};
		for (const m of members) n[m.role]++;
		return n;
	});
	const chips = $derived(
		(['all', ...ROLES] as RoleFilter[]).filter((r) => r === 'all' || counts[r] > 0 || filter === r)
	);
	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return members.filter(
			(m) =>
				(filter === 'all' || m.role === filter) &&
				(!q || `${m.name} ${m.email}`.toLowerCase().includes(q))
		);
	});
	const accessPerson = $derived(members.find((m) => m.userId === accessId) ?? null);
	// A person who cannot manage never sees the waiting list, so they are never left on its tab
	const activeTab = $derived(canManage ? tab : 'members');
	const note = $derived(
		viewerRole === 'owner'
			? counts.owner === 1
				? 'You can change anyone’s role. You are the only owner, so make someone else an owner before you step down.'
				: 'You can change anyone’s role. An organisation always keeps at least one owner.'
			: viewerRole === 'admin'
				? 'You can change members, viewers and guests. Only an owner can change an owner or an admin.'
				: 'You can see who is here. Only an owner or admin changes roles or invites people.'
	);

	// -- REACTIVE STATEMENTS -- //

	// The active tab slides to the middle of its row on a phone, with the row's own scroll so the page never moves
	$effect(() => {
		void activeTab;
		const row = tabRow;
		const current = row?.querySelector<HTMLElement>('[aria-selected="true"]');
		if (!row || !current || row.scrollWidth <= row.clientWidth) return;
		const left =
			current.getBoundingClientRect().left -
			row.getBoundingClientRect().left +
			row.scrollLeft -
			(row.clientWidth - current.offsetWidth) / 2;
		row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
	});

	// The drawer never stays open on nobody: a person who was removed meanwhile closes it
	$effect(() => {
		if (accessOpen && !accessPerson) accessOpen = false;
	});

	// -- FUNCTIONS -- //

	/** Runs one change with a toast, then reads the page again. A refusal shows its own message and changes nothing. */
	async function act(run: () => Promise<unknown>, ok: string): Promise<boolean> {
		try {
			await toast.promise(run(), {
				loading: 'Working on it...',
				success: ok,
				error: (e) => (e instanceof ApiError ? e.message : 'That did not work.')
			});
			await onchange();
			return true;
		} catch {
			return false;
		}
	}

	async function changeRole(person: MemberView, role: Role) {
		// Making an owner, or taking the role away, asks first: it decides who may delete the organisation
		if (role === 'owner' || person.role === 'owner') {
			const up = role === 'owner';
			const yes = await askConfirm({
				title: up
					? `Make ${person.name} an owner?`
					: `Change ${person.name} from owner to ${ROLE_LABEL[role]}?`,
				body: up
					? 'Owners can do everything, including changing other owners and deleting this organisation. Only give this role to someone you trust with all of it.'
					: 'They stop being able to change owners or delete the organisation. You can make them an owner again later.',
				confirmLabel: up ? 'Make owner' : 'Change role'
			});
			if (!yes) return;
		}
		const done = await act(
			() =>
				api(org, `/members/${person.userId}`, { method: 'PATCH', body: { role }, key: newKey() }),
			'Role changed.'
		);
		if (done) {
			flashId = person.userId;
			// A second change inside the first one's time starts its own tint, and the first timer is dropped
			clearTimeout(flashTimer);
			flashTimer = setTimeout(() => (flashId = null), 1400);
		}
	}

	async function removeMember(person: MemberView) {
		const yes = await askConfirm({
			title: `Remove ${person.name}?`,
			body: 'They lose access to the organisation at once, and so do the tokens they made. What they wrote stays.',
			confirmLabel: 'Remove',
			tone: 'danger'
		});
		if (!yes) return;
		await act(() => api(org, `/members/${person.userId}`, { method: 'DELETE' }), 'Removed.');
	}

	async function withdraw(invite: InviteView) {
		const yes = await askConfirm({
			title: 'Withdraw this invitation?',
			body: `The link in the email to ${invite.email} stops working. You can invite them again later.`,
			confirmLabel: 'Withdraw',
			tone: 'danger'
		});
		if (!yes) return;
		await act(
			() => api(org, `/invites/${invite.id}`, { method: 'DELETE' }),
			'Invitation withdrawn.'
		);
	}

	function openAccess(person: MemberView) {
		accessId = person.userId;
		accessOpen = true;
	}

	/** After an invitation was sent the person sees it in the waiting list. */
	async function sent() {
		await onchange();
		tab = 'invitations';
	}
</script>

<!-- MEMBERS AND ROLES. ONE PRIMARY ACTION IN THE HEADER OPENS THE INVITE DIALOG, THE LIST IS ONE ALIGNED TABLE -->
<Section
	id="members"
	icon={Users}
	group="People"
	title="Members and roles"
	text="Who is in this organisation and what they may do. Changes apply at once."
	readonly={!canManage}
>
	{#snippet actions()}
		<Button variant="subtle" onclick={() => (guideOpen = true)} data-testid="role-guide">
			<CircleHelp size={16} /> Role guide
		</Button>
		{#if canManage}
			<Button variant="primary" onclick={() => (inviteOpen = true)} data-testid="invite-open">
				<UserPlus size={16} /> Invite people
			</Button>
		{/if}
	{/snippet}

	<!-- TABS: MEMBERS AND THE WAITING LIST -->
	<div
		bind:this={tabRow}
		role="tablist"
		aria-label="People"
		class="-mt-1 flex [scrollbar-width:none]! gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-line [&::-webkit-scrollbar]:hidden"
	>
		<button
			type="button"
			role="tab"
			id="people-tab-members"
			aria-selected={activeTab === 'members'}
			aria-controls={activeTab === 'members' ? 'people-panel-members' : undefined}
			onclick={() => (tab = 'members')}
			class="relative flex min-h-11 shrink-0 cursor-pointer items-center gap-2 border-b-2 border-transparent px-4 text-sm whitespace-nowrap text-muted hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent aria-selected:border-accent aria-selected:font-medium aria-selected:text-ink"
		>
			Members <Badge>{members.length}</Badge>
		</button>
		{#if canManage}
			<button
				type="button"
				role="tab"
				id="people-tab-invitations"
				aria-selected={activeTab === 'invitations'}
				aria-controls={activeTab === 'invitations' ? 'people-panel-invitations' : undefined}
				onclick={() => (tab = 'invitations')}
				class="relative flex min-h-11 shrink-0 cursor-pointer items-center gap-2 border-b-2 border-transparent px-4 text-sm whitespace-nowrap text-muted hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent aria-selected:border-accent aria-selected:font-medium aria-selected:text-ink"
			>
				Waiting for a reply <Badge tone={invites.length ? 'warning' : 'neutral'}
					>{invites.length}</Badge
				>
			</button>
		{/if}
	</div>

	{#if activeTab === 'members'}
		<div
			id="people-panel-members"
			role="tabpanel"
			aria-labelledby="people-tab-members"
			class="flex flex-col gap-3"
		>
			<!-- FILTERS: A CHIP FOR EACH ROLE WITH ITS COUNT, AND SEARCH -->
			<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
				<div
					role="group"
					aria-label="Filter by role"
					class="flex min-w-0 flex-wrap gap-1.5 max-sm:w-full max-sm:[scrollbar-width:none]! max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:overflow-y-hidden max-sm:[&::-webkit-scrollbar]:hidden"
				>
					{#each chips as r (r)}
						<button
							type="button"
							aria-pressed={filter === r}
							onclick={() => (filter = r)}
							class={cn(
								'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors max-sm:h-11',
								filter === r
									? 'border-accent/35 bg-accent-soft text-accent-text'
									: 'border-line bg-surface text-muted hover:bg-raised hover:text-ink'
							)}
						>
							{r === 'all' ? 'Everyone' : `${ROLE_LABEL[r]}s`}
							<span class="font-mono text-[11px]">{counts[r]}</span>
						</button>
					{/each}
				</div>
				<TextField
					label="Search people"
					hideLabel
					icon={Search}
					type="search"
					placeholder="Search people"
					autocomplete="off"
					bind:value={query}
					class="w-full max-sm:order-first sm:w-56"
				/>
			</div>

			<!-- WHAT THIS PERSON MAY DO, IN THEIR OWN ROLE -->
			<div
				class="flex items-start gap-2.5 rounded-lg border border-line bg-raised px-3 py-2.5 text-xs text-muted"
			>
				<Info size={16} class="mt-0.5 shrink-0" />
				<span>{note}</span>
			</div>

			{#if shown.length}
				<ul class="overflow-hidden rounded-lg border border-line" data-testid="member-list">
					<TableHead person="Person" role="Role" access={canManage ? 'Access' : 'Joined'} />
					{#each shown as m (m.userId)}
						<MemberRow
							person={m}
							{viewerRole}
							{viewerId}
							access={canManage ? accessSummary(m, projects, projectRoles) : ''}
							flash={flashId === m.userId}
							ownerCount={counts.owner}
							onrole={(r) => changeRole(m, r)}
							onremove={() => removeMember(m)}
							onaccess={() => openAccess(m)}
							onguide={() => (guideOpen = true)}
						/>
					{/each}
				</ul>
			{:else}
				<!-- NO ONE MATCHES -->
				<div
					class="flex flex-col items-center gap-1 rounded-lg border border-dashed border-line px-4 py-8 text-center"
				>
					<span
						class="mb-1 inline-flex size-10 items-center justify-center rounded-full bg-raised text-muted"
					>
						<Search size={20} />
					</span>
					<p class="text-sm font-medium text-ink">
						{query.trim() ? `No one matches “${query.trim()}”` : 'No one has this role yet'}
					</p>
					<p class="text-xs text-muted">Try another name, an email address or a different role.</p>
				</div>
			{/if}
		</div>
	{:else}
		<div
			id="people-panel-invitations"
			role="tabpanel"
			aria-labelledby="people-tab-invitations"
			class="flex flex-col gap-3"
		>
			<InvitationsList
				{invites}
				{members}
				oninvite={() => (inviteOpen = true)}
				onwithdraw={withdraw}
			/>
		</div>
	{/if}
</Section>

<!-- DIALOGS: ALWAYS MOUNTED, SO THEY FADE OUT -->
<InviteModal
	open={canManage && inviteOpen}
	onclose={() => (inviteOpen = false)}
	{org}
	{viewerRole}
	{allowGuests}
	onsent={sent}
/>
<ProjectAccessDrawer
	open={canManage && accessOpen}
	onclose={() => (accessOpen = false)}
	{org}
	person={accessPerson}
	{projects}
	overrides={projectRoles}
	{viewerRole}
	onchanged={onchange}
/>
<RoleGuide open={guideOpen} onclose={() => (guideOpen = false)} />
