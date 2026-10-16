<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- DEP-MODULES -- //
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	// -- ENVS -- //
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import SettingsShell from '#lib/settings/SettingsShell.svelte';
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import { verbText } from '#lib/board/verbs.js';
	import { ROLE_LABEL, type Role } from '#lib/shared/roles.js';
	import { createFollower } from '#lib/settings/follow.js';
	import PalettePicker from '#lib/settings/PalettePicker.svelte';
	import Runners from '#lib/settings/Runners.svelte';
	import Section from '#lib/settings/Section.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Select from '#lib/ui/Select.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';

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
	let newKey_ = $state('');
	let newName = $state('');
	let extraAudit = $state<AuditEvents>([]);
	/** Bumped after a failed change, so a dropdown that moved on screen is drawn again from what is saved. */
	let rev = $state(0);
	let nextAudit = $state<number | null>(null);
	let auditProject = $state('');
	let busyTest = $state(false);

	// -- REACTIVE STATES -- //

	const org = $derived(data.org.slug);
	const s = $derived(data.settings);
	const can = $derived(s.canManage);
	const events = $derived([...(data.audit?.events ?? []), ...extraAudit]);
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
	async function save(id: string, body: Record<string, unknown>) {
		status[id] = { saving: true, saved: false, error: '' };
		try {
			await api(org, '/settings', { method: 'PATCH', body, key: newKey() });
			// The name, the palette and the logo also show in the page header, so everything is read again
			await invalidateAll();
			status[id] = { saving: false, saved: true, error: '' };
		} catch (e) {
			status[id] = {
				saving: false,
				saved: false,
				error: e instanceof ApiError ? e.message : 'That was not saved.'
			};
		}
	}

	async function act(run: () => Promise<unknown>, ok: string) {
		try {
			await run();
			toast.success(ok);
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'That did not work.');
			// A control that was changed on screen shows what is saved again
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
	const createProject = () =>
		act(
			() =>
				api(org, '/projects', {
					body: { key: newKey_.trim().toUpperCase(), name: newName.trim() }
				}),
			'Project created.'
		).then(() => {
			newKey_ = '';
			newName = '';
		});

	async function uploadLogo(file: File | undefined) {
		if (!file) return;
		await act(async () => {
			const res = await fetch(`/api/v1/orgs/${org}/logo?type=${encodeURIComponent(file.type)}`, {
				method: 'PUT',
				headers: { 'content-type': file.type },
				body: file
			});
			if (!res.ok) {
				const j = await res.json().catch(() => null);
				throw new ApiError(
					res.status,
					j?.error?.code ?? 'ERROR',
					j?.error?.message ?? 'The logo was not saved.'
				);
			}
		}, 'Logo saved.');
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
			title="Name"
			text="The name people see at the top of every page."
			dirty={dirty.general}
			saving={st('general').saving}
			saved={st('general').saved}
			error={st('general').error}
			readonly={!can}
			onsave={() => save('general', { name: name.trim() })}
		>
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
			title="Colour and logo"
			text="The accent colour of buttons, links and progress for everyone in this organisation. Dark mode follows."
			dirty={dirty.palette}
			saving={st('palette').saving}
			saved={st('palette').saved}
			error={st('palette').error}
			readonly={!can}
			onsave={() => save('palette', { accent })}
		>
			<PalettePicker bind:value={accent} disabled={!can} />
			<div class="flex flex-wrap items-center gap-3 border-t border-line pt-3">
				{#if s.logo}
					<img
						src={s.logo}
						alt="The current logo"
						class="size-11 rounded-lg border border-line object-contain"
					/>
				{/if}
				{#if can}
					<label class="flex flex-col gap-1 text-xs font-medium text-muted">
						Logo, a PNG, JPEG or WebP under 200 KB
						<input
							type="file"
							accept="image/png,image/jpeg,image/webp"
							data-testid="logo-file"
							onchange={(e) => void uploadLogo(e.currentTarget.files?.[0])}
							class="min-h-11 text-sm file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:text-sm"
						/>
					</label>
					{#if s.logo}
						<Button
							size="sm"
							variant="ghost"
							onclick={() => act(() => api(org, '/logo', { method: 'DELETE' }), 'Logo removed.')}
							data-testid="logo-remove">Remove the logo</Button
						>
					{/if}
				{/if}
			</div>
		</Section>

		<Section
			id="members"
			title="Members and roles"
			text="Who is in this organisation and what they may do. Changes apply at once."
		>
			<ul class="rounded-lg border border-line" data-testid="member-list">
				{#each data.members as m (`${m.userId}-${rev}`)}
					<li
						class="flex min-h-12 flex-wrap items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
						data-item
						data-testid="member"
					>
						<span class="min-w-0 flex-1 text-sm"
							>{m.name} <span class="text-muted">{m.email}</span></span
						>
						{#if can}
							<Select
								label={`Role of ${m.name}`}
								value={m.role}
								options={roleOptions}
								onchange={(v) => changeRole(m.userId, v)}
								class="w-36"
							/>
							<Button size="sm" variant="ghost" onclick={() => removeMember(m.userId)}
								>Remove</Button
							>
						{:else}
							<Badge>{ROLE_LABEL[m.role]}</Badge>
						{/if}
					</li>
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
					<ul class="rounded-lg border border-line" data-testid="invite-list">
						{#each data.invites as i (i.id)}
							<li
								class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
								data-item
							>
								<span class="min-w-0 flex-1 text-sm">{i.email}</span>
								<Badge>{ROLE_LABEL[i.role as Role]}</Badge>
								<Button size="sm" variant="ghost" onclick={() => withdraw(i.id)}>Withdraw</Button>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</Section>

		<Section
			id="projects"
			title="Projects"
			text="Each project has its own plans, settings and repository."
		>
			<ul class="rounded-lg border border-line">
				{#each data.projects as p (p.id)}
					<li
						class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
						data-item
					>
						<span class="w-16 shrink-0 font-mono text-xs text-muted">{p.key}</span>
						<a
							class="min-w-0 flex-1 truncate text-sm text-accent-text hover:underline"
							href={`/${org}/${p.key}`}>{p.name}</a
						>
						<a class="text-xs text-muted hover:underline" href={`/${org}/${p.key}/settings`}
							>Settings</a
						>
					</li>
				{/each}
			</ul>
			{#if can}
				<form
					class="flex flex-wrap items-end gap-2"
					onsubmit={(e) => {
						e.preventDefault();
						void createProject();
					}}
				>
					<TextField
						label="Key, 2 to 10 capitals"
						bind:value={newKey_}
						class="w-40"
						data-testid="project-key"
						required
					/>
					<TextField
						label="Project name"
						bind:value={newName}
						class="min-w-56 flex-1"
						data-testid="project-name"
						required
					/>
					<Button type="submit" variant="primary" data-testid="project-create"
						>Create project</Button
					>
				</form>
			{/if}
		</Section>

		<Section
			id="email"
			title="Email sending"
			text="How this server sends invitations, sign in codes and alerts."
		>
			{#if data.email.configured}
				<div class="text-sm">
					Sending through <Badge tone="info">{data.email.provider}</Badge>
					{#if data.email.provider === 'log'}
						<span class="text-muted"
							>The log sender only writes mail to a file, nothing leaves the server.</span
						>
					{/if}
				</div>
				{#if can}
					<form
						method="POST"
						action="?/testEmail"
						class="flex flex-wrap items-center gap-3"
						use:enhance={() => {
							busyTest = true;
							return async ({ update }) => {
								await update();
								busyTest = false;
							};
						}}
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

		<Runners {org} projects={data.projects} {can} baseUrl={page.url.origin} />

		{#if can}
			<Section
				id="backups"
				title="Backups"
				text="A nightly encrypted copy of this organisation, kept apart from the app. A copy on GitHub is a reference, not a backup."
			>
				{#if !data.backups?.enabled}
					<div class="text-sm text-muted" data-testid="backups-off">
						Backups are not set up on this server. An operator turns them on with a backup key.
					</div>
				{:else}
					<div class="flex flex-wrap items-center gap-2 text-sm" data-testid="backups-status">
						<Badge tone={data.backups.health.ok ? 'success' : 'danger'}
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
						<ul class="rounded-lg border border-line">
							{#each data.backups.runs as r (r.id)}
								<li
									class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0"
									data-item
								>
									<Badge tone={r.state === 'done' ? 'success' : 'danger'}>{r.state}</Badge>
									<span class="min-w-0 flex-1 truncate"
										>{r.state === 'failed'
											? r.error
											: `${Math.round((r.size ?? 0) / 1024)} KB`}</span
									>
									<span class="text-xs text-muted">{ago(r.createdAt)}</span>
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			</Section>

			<Section
				id="limits"
				title="Security limits"
				text="How long access tokens may live, and whether guests may be invited."
				dirty={dirty.limits}
				saving={st('limits').saving}
				saved={st('limits').saved}
				error={st('limits').error}
				onsave={() => save('limits', { tokenMaxDays, allowGuestInvites: allowGuests })}
			>
				<Select
					label="Longest life of an access token"
					value={String(tokenMaxDays)}
					options={TOKEN_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))}
					onchange={(v) => (tokenMaxDays = Number(v))}
					class="w-48"
				/>
				<Switch
					label="Guests may be invited"
					hint="A guest sees only what is shared and may comment."
					bind:checked={allowGuests}
				/>
			</Section>

			<Section
				id="audit"
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
					<ul class="rounded-lg border border-line" data-testid="audit-list">
						{#each shownEvents as e (e.id)}
							<li
								class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
								data-item
								data-testid="audit-event"
							>
								<span class="w-14 shrink-0 font-mono text-xs text-muted">{e.project}</span>
								<span class="min-w-0 flex-1 truncate text-sm"
									><span class="font-medium">{e.actorLabel ?? 'Someone'}</span>
									{verbText(e.verb)}</span
								>
								<span class="shrink-0 text-xs text-muted">{ago(e.createdAt)}</span>
							</li>
						{/each}
					</ul>
					{#if nextAudit !== null}
						<div>
							<Button size="sm" onclick={moreAudit} data-testid="audit-more">Show more</Button>
						</div>
					{/if}
				{/if}
			</Section>
		{/if}
	</SettingsShell>
</PageFrame>
