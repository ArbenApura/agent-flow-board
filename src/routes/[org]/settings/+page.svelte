<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- DEP-MODULES -- //
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	// -- ENVS -- //
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import SettingsShell from '#lib/settings/SettingsShell.svelte';
	import { ApiError, api, deletePicture, newKey, putPicture } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import { verbText } from '#lib/board/verbs.js';
	import { addDays, formatUtcDate, groupByDay } from '#lib/board/when.js';
	import { ORG_DELETE_GRACE_DAYS, sameOrgName } from '#lib/shared/orgDeletion.js';
	import { ROLE_LABEL, type Role } from '#lib/shared/roles.js';
	import { createFollower } from '#lib/settings/follow.js';
	import IdentityHeader from '#lib/settings/IdentityHeader.svelte';
	import PalettePicker from '#lib/settings/PalettePicker.svelte';
	import Runners from '#lib/settings/Runners.svelte';
	import Section from '#lib/settings/Section.svelte';
	import SettingsRow from '#lib/settings/SettingsRow.svelte';
	import OrgTile from '#lib/board/OrgTile.svelte';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import PictureUpload from '#lib/ui/PictureUpload.svelte';
	import Select from '#lib/ui/Select.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { toastEnhance } from '#lib/ui/toastEnhance.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Settings from '@lucide/svelte/icons/settings';
	import Palette from '@lucide/svelte/icons/palette';
	import Users from '@lucide/svelte/icons/users';
	import Mail from '@lucide/svelte/icons/mail';
	import DatabaseBackup from '@lucide/svelte/icons/database-backup';
	import Gauge from '@lucide/svelte/icons/gauge';
	import ScrollText from '@lucide/svelte/icons/scroll-text';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- TYPES -- //

	type AuditEvents = NonNullable<PageProps['data']['audit']>['events'];

	// -- CONSTANTS -- //

	const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer', 'guest'];
	const roleOptions = ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }));
	const TOKEN_DAYS = [7, 14, 30, 60, 90];

	// -- STATES -- //

	let name = $state('');
	let accent = $state<string | null>(null);
	let tokenMaxDays = $state(90);
	let allowGuests = $state(true);
	let status = $state<Record<string, { saving: boolean; saved: boolean; error: string }>>({});
	let inviteEmail = $state('');
	let inviteRole = $state<Role>('member');
	let extraAudit = $state<AuditEvents>([]);
	/** Bumped after a failed change, so a dropdown that moved on screen is drawn again from what is saved. */
	let rev = $state(0);
	let nextAudit = $state<number | null>(null);
	let auditProject = $state('');
	let busyTest = $state(false);
	let deleteOpen = $state(false);
	let typedName = $state('');
	/** Kept while the dialog closes, so its numbers do not vanish during the transition. */
	let deleteCounts = $state<{ projects: number; items: number; files: number } | null>(null);

	// -- REACTIVE STATES -- //

	const org = $derived(data.org.slug);
	const s = $derived(data.settings);
	const can = $derived(s.canManage);
	const isOwner = $derived(data.org.role === 'owner');
	const events = $derived([...(data.audit?.events ?? []), ...extraAudit]);
	// The worked example under the token limit: a token made today lives this many days. UTC on both sides, so the page hydrates without a jump
	const tokenExpiry = $derived(formatUtcDate(addDays(Date.now(), tokenMaxDays)));
	const biggestBackup = $derived(
		Math.max(1, ...(data.backups?.runs ?? []).map((r) => r.size ?? 0))
	);
	const dirty = $derived({
		general: name.trim() !== s.name,
		palette: (accent ?? null) !== (s.accent ?? null),
		limits: tokenMaxDays !== s.settings.tokenMaxDays || allowGuests !== s.settings.allowGuestInvites
	});

	// -- FUNCTIONS -- //

	const st = (id: string) => status[id] ?? { saving: false, saved: false, error: '' };

	// The fields follow the saved values whenever the page data is replaced
	const follow = createFollower();
	$effect(() => {
		follow('name', s.name, (v) => (name = v));
		follow('accent', s.accent, (v) => (accent = v));
		follow('tokenMaxDays', s.settings.tokenMaxDays, (v) => (tokenMaxDays = v));
		follow('allowGuests', s.settings.allowGuestInvites, (v) => (allowGuests = v));
		follow('audit', data.audit?.events[0]?.id ?? null, () => {
			nextAudit = data.audit?.next ?? null;
			extraAudit = [];
			filtered = false;
		});
	});

	/** Saves one section: sends only its own fields, and shows its own result. */
	async function save(id: string, body: Record<string, unknown>, ok = 'Saved.') {
		status[id] = { saving: true, saved: false, error: '' };
		try {
			// The toast wraps the raw write, so a refusal rejects it and no success toast shows
			await toast.promise(api(org, '/settings', { method: 'PATCH', body, key: newKey() }), {
				id: `save-${id}`,
				loading: 'Saving...',
				success: ok,
				error: (e) => (e instanceof ApiError ? e.message : 'That was not saved.')
			});
		} catch (e) {
			status[id] = {
				saving: false,
				saved: false,
				error: e instanceof ApiError ? e.message : 'That was not saved.'
			};
			return;
		}
		// The name, the palette and the logo also show in the page header, so everything is read again
		await invalidateAll();
		status[id] = { saving: false, saved: true, error: '' };
	}

	async function act(run: () => Promise<unknown>, ok: string) {
		try {
			await toast.promise(run(), {
				loading: 'Working on it...',
				success: ok,
				error: (e) => (e instanceof ApiError ? e.message : 'That did not work.')
			});
			await invalidateAll();
		} catch {
			// The promise toast already shows the failure. A control that was changed on screen shows what is saved again
			rev++;
		}
	}

	const changeRole = (userId: string, role: string) =>
		act(() => api(org, `/members/${userId}`, { method: 'PATCH', body: { role } }), 'Role changed.');
	const removeMember = async (userId: string) => {
		if (
			!(await askConfirm({
				title: 'Remove this person?',
				body: 'They lose access to the organisation at once, and so do the tokens they made.',
				confirmLabel: 'Remove'
			}))
		)
			return;
		await act(() => api(org, `/members/${userId}`, { method: 'DELETE' }), 'Removed.');
	};
	const invite = () =>
		act(
			() => api(org, '/invites', { body: { email: inviteEmail.trim(), role: inviteRole } }),
			'Invitation sent.'
		).then(() => (inviteEmail = ''));
	const withdraw = async (id: string) => {
		if (
			!(await askConfirm({
				title: 'Withdraw this invitation?',
				body: 'The link in the email stops working.',
				confirmLabel: 'Withdraw'
			}))
		)
			return;
		await act(() => api(org, `/invites/${id}`, { method: 'DELETE' }), 'Invitation withdrawn.');
	};

	async function openDelete() {
		typedName = '';
		deleteCounts = null;
		deleteOpen = true;
		try {
			deleteCounts = await api(org, '/deletion');
		} catch {
			// The numbers are a courtesy: the dialog still works without them
		}
	}

	async function deleteOrganisation() {
		await toast.promise(api(org, '/delete', { body: { name: typedName } }), {
			id: 'delete-organisation',
			loading: 'Deleting the organisation...',
			success: 'Organisation scheduled for deletion.',
			error: (e) => (e instanceof Error ? e.message : 'The organisation was not deleted.')
		});
		await goto(`/deleted/${org}`, { invalidateAll: true });
	}

	async function uploadLogo(file: File | undefined) {
		if (!file) return;
		await act(() => putPicture(`/orgs/${org}/logo`, file), 'Logo saved.');
	}

	async function moreAudit() {
		if (nextAudit === null) return;
		const params = new SvelteURLSearchParams({ before: String(nextAudit), limit: '25' });
		if (auditProject) params.set('project', auditProject);
		const more = await api<{ events: AuditEvents; next: number | null }>(org, `/audit?${params}`);
		extraAudit = [...extraAudit, ...more.events];
		nextAudit = more.next;
	}

	async function filterAudit(project: string) {
		auditProject = project;
		const params = new SvelteURLSearchParams({ limit: '25' });
		if (project) params.set('project', project);
		const first = await api<{ events: AuditEvents; next: number | null }>(org, `/audit?${params}`);
		extraAudit = first.events;
		nextAudit = first.next;
		filtered = true;
	}
	let filtered = $state(false);
	const shownEvents = $derived(filtered ? extraAudit : events);
	const auditDays = $derived(groupByDay(shownEvents, (e) => e.createdAt));
</script>

<svelte:head><title>Organisation settings, {data.org.name}</title></svelte:head>

<PageFrame class="pb-12">
	<PageHeader
		title="Organisation settings"
		context={can
			? 'Each section saves on its own.'
			: 'You can look at these. An admin or owner changes them.'}
	/>

	<SettingsShell>
		<Section
			id="general"
			icon={Settings}
			group="Organisation"
			title="Name"
			text="The name people see at the top of every page."
			dirty={dirty.general}
			saving={st('general').saving}
			saved={st('general').saved}
			error={st('general').error}
			readonly={!can}
			onsave={() => save('general', { name: name.trim() }, 'Organisation details saved.')}
		>
			<IdentityHeader title={data.org.name} subtitle={`/${data.org.slug}`}>
				{#snippet lead()}<OrgTile name={data.org.name} logo={s.logo} size={40} />{/snippet}
				<Badge tone="accent">{ROLE_LABEL[data.org.role as Role]}</Badge>
				<Badge>{data.members.length} {data.members.length === 1 ? 'member' : 'members'}</Badge>
			</IdentityHeader>
			<TextField
				label="Organisation name"
				bind:value={name}
				disabled={!can}
				data-testid="org-name-input"
			/>
			<div class="text-xs text-muted">Its address is /{data.org.slug} and does not change.</div>
		</Section>

		<Section
			id="palette"
			icon={Palette}
			group="Organisation"
			title="Colour and logo"
			text="Shared by everyone in this organisation: the accent colour and the logo. Members only choose light or dark for themselves, in their account settings."
			dirty={dirty.palette}
			saving={st('palette').saving}
			saved={st('palette').saved}
			error={st('palette').error}
			readonly={!can}
			onsave={() => save('palette', { accent }, 'Colour saved.')}
		>
			<PalettePicker bind:value={accent} label="Organisation accent colour" disabled={!can} />
			<PictureUpload
				label="Logo"
				removeLabel="Remove the logo"
				hasPicture={Boolean(s.logo)}
				canEdit={can}
				testid="logo"
				onupload={(f) => void uploadLogo(f)}
				onremove={() => act(() => deletePicture(`/orgs/${org}/logo`), 'Logo removed.')}
			>
				{#snippet preview()}<OrgTile name={data.org.name} logo={s.logo} size={40} />{/snippet}
			</PictureUpload>
		</Section>

		<Section
			id="members"
			icon={Users}
			group="People"
			title="Members and roles"
			text="Who is in this organisation and what they may do. Changes apply at once."
		>
			<ul class="overflow-hidden rounded-lg border border-line" data-testid="member-list">
				{#each data.members as m (`${m.userId}-${rev}`)}
					<SettingsRow data-testid="member">
						{#snippet lead()}<Avatar name={m.name} userId={m.userId} v={m.imageV} />{/snippet}
						<span class="block truncate font-medium text-ink">{m.name}</span>
						<span class="block truncate text-xs text-muted">{m.email}</span>
						{#snippet trail()}
							{#if can}
								<Select
									label={`Role of ${m.name}`}
									value={m.role}
									options={roleOptions}
									onchange={(v) => changeRole(m.userId, v)}
									class="w-36"
								/>
								<Button
									variant="secondary"
									class="text-danger"
									onclick={() => removeMember(m.userId)}>Remove</Button
								>
							{:else}
								<Badge>{ROLE_LABEL[m.role]}</Badge>
							{/if}
						{/snippet}
					</SettingsRow>
				{/each}
			</ul>
			{#if can}
				<form
					class="flex flex-wrap items-end gap-2"
					onsubmit={(e) => {
						e.preventDefault();
						void invite();
					}}
				>
					<TextField
						label="Invite by email"
						type="email"
						bind:value={inviteEmail}
						class="min-w-56 flex-1"
						data-testid="invite-email"
						required
					/>
					<Select
						label="Role of the invited person"
						bind:value={inviteRole}
						options={roleOptions}
						class="w-36"
					/>
					<Button type="submit" variant="primary" data-testid="invite-submit"
						>Send invitation</Button
					>
				</form>
				{#if data.invites.length}
					<div class="text-xs font-medium text-muted">Waiting for a reply</div>
					<ul class="overflow-hidden rounded-lg border border-line" data-testid="invite-list">
						{#each data.invites as i (i.id)}
							<SettingsRow>
								{#snippet lead()}
									<span
										class="inline-flex size-8 items-center justify-center rounded-full border border-dashed border-line text-muted"
										aria-hidden="true"><Mail size={16} /></span
									>
								{/snippet}
								<span class="block truncate font-medium text-ink">{i.email}</span>
								<span class="block truncate text-xs text-muted">Sent {ago(i.createdAt)}</span>
								{#snippet trail()}
									<Badge>{ROLE_LABEL[i.role as Role]}</Badge>
									<Button variant="secondary" class="text-danger" onclick={() => withdraw(i.id)}
										>Withdraw</Button
									>
								{/snippet}
							</SettingsRow>
						{/each}
					</ul>
				{/if}
			{/if}
		</Section>

		<Section
			id="email"
			icon={Mail}
			group="Delivery"
			title="Email sending"
			text="How this server sends invitations, sign in codes and alerts."
		>
			{#if data.email.configured}
				<!-- THE PROVIDER CARD. A REAL PROVIDER IS GREEN, THE LOG SENDER IS AMBER BECAUSE NOTHING LEAVES THE SERVER -->
				<div
					class="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-raised/50 p-3"
				>
					<span class="min-w-0 flex-1 text-sm">
						Sending through <Badge tone={data.email.provider === 'log' ? 'warning' : 'success'} dot
							>{data.email.provider}</Badge
						>
						{#if data.email.provider === 'log'}
							<span class="block text-muted"
								>The log sender only writes mail to a file, nothing leaves the server.</span
							>
						{/if}
					</span>
				</div>
				{#if can}
					<form
						method="POST"
						action="?/testEmail"
						class="flex flex-wrap items-center gap-3"
						use:enhance={toastEnhance({
							id: 'test-email',
							loading: 'Sending the test email...',
							success: 'Test email sent.',
							inline: true,
							// The form's own update keeps its default reset
							reset: true,
							onStart: () => (busyTest = true),
							onDone: () => (busyTest = false)
						})}
					>
						<Button type="submit" loading={busyTest} data-testid="test-email"
							>Send me a test email</Button
						>
						{#if form?.sent}
							<span class="text-sm text-success" role="status" data-testid="test-email-result"
								>Sent to {form.to}.</span
							>
						{:else if form?.message}
							<span class="text-sm text-danger" role="alert" data-testid="test-email-result"
								>{form.message}</span
							>
						{/if}
					</form>
				{/if}
			{:else}
				<div class="text-sm text-muted">This server has no way to send email yet.</div>
			{/if}
		</Section>

		<Runners {org} projects={data.projects} {can} baseUrl={page.url.origin} group="Delivery" />

		{#if can}
			<Section
				id="backups"
				icon={DatabaseBackup}
				group="Delivery"
				title="Backups"
				text="A nightly encrypted copy of this organisation, kept apart from the app. A copy on GitHub is a reference, not a backup."
			>
				{#if !data.backups?.enabled}
					<div class="text-sm text-muted" data-testid="backups-off">
						Backups are not set up on this server. An operator turns them on with a backup key.
					</div>
				{:else}
					<div
						class="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised/50 p-3 text-sm"
						data-testid="backups-status"
					>
						<Badge tone={data.backups.health.ok ? 'success' : 'danger'} dot
							>{data.backups.health.ok ? 'healthy' : 'needs attention'}</Badge
						>
						{#if data.backups.health.message}<span class="text-danger"
								>{data.backups.health.message}</span
							>{/if}
						{#if data.backups.health.lastOkAt}<span class="text-muted"
								>Last good backup {ago(data.backups.health.lastOkAt)}.</span
							>{/if}
					</div>
					{#if data.backups.runs.length}
						<ul class="overflow-hidden rounded-lg border border-line">
							{#each data.backups.runs as r (r.id)}
								<SettingsRow>
									{#snippet lead()}
										<Badge tone={r.state === 'done' ? 'success' : 'danger'}>{r.state}</Badge>
									{/snippet}
									{#if r.state === 'failed'}
										<span class="block truncate text-danger">{r.error}</span>
									{:else}
										<span class="block">{Math.round((r.size ?? 0) / 1024)} KB</span>
										<!-- THE BAR IS THE SIZE OF THIS COPY AGAINST THE BIGGEST ONE, A RUNTIME PERCENT -->
										<span
											class="mt-1 block h-1 w-full max-w-48 overflow-hidden rounded-full bg-raised"
											><span
												class="block h-full rounded-full bg-accent"
												style="width: {Math.round(((r.size ?? 0) / biggestBackup) * 100)}%"
											></span></span
										>
									{/if}
									{#snippet trail()}<span class="text-xs text-muted">{ago(r.createdAt)}</span
										>{/snippet}
								</SettingsRow>
							{/each}
						</ul>
					{/if}
				{/if}
			</Section>

			<Section
				id="limits"
				icon={Gauge}
				group="Safety"
				title="Security limits"
				text="How long access tokens may live, and whether guests may be invited."
				dirty={dirty.limits}
				saving={st('limits').saving}
				saved={st('limits').saved}
				error={st('limits').error}
				onsave={() =>
					save('limits', { tokenMaxDays, allowGuestInvites: allowGuests }, 'Limits saved.')}
			>
				<Select
					label="Longest life of an access token"
					value={String(tokenMaxDays)}
					options={TOKEN_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))}
					onchange={(v) => (tokenMaxDays = Number(v))}
					class="w-48"
				/>
				<!-- THE WORKED EXAMPLE, SO A WRONG ANSWER SHOWS BEFORE IT IS SAVED. THE DATE IS UTC -->
				<p
					class="rounded-lg border border-line bg-raised/50 p-3 text-sm text-ink"
					data-testid="limit-example"
				>
					A token made today expires on <span class="font-semibold">{tokenExpiry}</span>
					(UTC), {tokenMaxDays} days from now.
				</p>
				<Switch
					label="Guests may be invited"
					hint="A guest sees only what is shared and may comment."
					bind:checked={allowGuests}
				/>
			</Section>

			<Section
				id="audit"
				icon={ScrollText}
				group="Safety"
				title="Audit log"
				text="Everything that changed in this organisation, newest first."
			>
				<div class="flex flex-wrap items-end gap-2">
					<Select
						label="Project"
						value={auditProject}
						options={[
							{ value: '', label: 'Every project' },
							...data.projects.map((p) => ({ value: p.key, label: p.key }))
						]}
						onchange={(v) => filterAudit(v)}
						class="w-44"
					/>
				</div>
				{#if shownEvents.length === 0}
					<div class="text-sm text-muted">Nothing has happened here yet.</div>
				{:else}
					<!-- A TIMELINE: A RAIL WITH A NODE PER EVENT, GROUPED BY UTC DAY -->
					<div class="flex flex-col gap-4" data-testid="audit-list">
						{#each auditDays as day (day.key)}
							<section aria-label={day.label}>
								<h3 class="mb-1 text-xs font-medium text-muted">{day.label}</h3>
								<ol class="ml-1.5 border-l border-line">
									{#each day.items as e (e.id)}
										<li
											class="relative flex min-h-12 flex-wrap items-center gap-x-3 py-2 pl-5"
											data-item
											data-row
											data-testid="audit-event"
										>
											<span
												class="absolute top-1/2 -left-[4.5px] size-2 -translate-y-1/2 rounded-full border border-line bg-surface"
												aria-hidden="true"
											></span>
											<span class="w-14 shrink-0 font-mono text-xs text-muted">{e.project}</span>
											<span class="min-w-0 flex-1 truncate text-sm"
												><span class="font-medium">{e.actorLabel ?? 'Someone'}</span>
												{verbText(e.verb)}</span
											>
											<span class="shrink-0 text-xs text-muted">{ago(e.createdAt)}</span>
										</li>
									{/each}
								</ol>
							</section>
						{/each}
					</div>
					{#if nextAudit !== null}
						<div>
							<Button size="sm" onclick={moreAudit} data-testid="audit-more">Show more</Button>
						</div>
					{/if}
				{/if}
			</Section>
		{/if}

		{#if isOwner}
			<Section
				id="delete"
				group="Safety"
				icon={Trash2}
				title="Delete this organisation"
				text={`Hides it for everyone now, and erases it for good after ${ORG_DELETE_GRACE_DAYS} days. An owner can restore it until then.`}
			>
				<div>
					<Button variant="danger" onclick={openDelete} data-testid="delete-org"
						>Delete this organisation</Button
					>
				</div>
			</Section>
		{/if}
	</SettingsShell>
</PageFrame>

<!-- DELETING AN ORGANISATION NEEDS ITS NAME TYPED, SO A MISTAKEN CLICK CANNOT DO IT -->
<ConfirmDialog
	open={deleteOpen}
	onclose={() => (deleteOpen = false)}
	title="Delete this organisation?"
	confirmLabel="Delete this organisation"
	tone="danger"
	confirmDisabled={!sameOrgName(typedName, data.org.name)}
	onconfirm={deleteOrganisation}
>
	<div class="flex flex-col gap-3 text-[15px] leading-6" data-testid="delete-dialog">
		<p>
			{data.org.name} is hidden for everyone at once, and erased for good after {ORG_DELETE_GRACE_DAYS}
			days. Its tokens, runners and connected tools stop working now.
		</p>
		{#if deleteCounts}
			<p class="text-muted" data-testid="delete-counts">
				It holds {deleteCounts.projects}
				{deleteCounts.projects === 1 ? 'project' : 'projects'}, {deleteCounts.items}
				{deleteCounts.items === 1 ? 'item' : 'items'} and {deleteCounts.files}
				{deleteCounts.files === 1 ? 'file' : 'files'}.
			</p>
		{/if}
		<TextField
			label="Type the organisation name to confirm"
			bind:value={typedName}
			placeholder={data.org.name}
			autocomplete="off"
			autocapitalize="off"
			autocorrect="off"
			spellcheck={false}
			data-testid="delete-name"
		/>
	</div>
</ConfirmDialog>
