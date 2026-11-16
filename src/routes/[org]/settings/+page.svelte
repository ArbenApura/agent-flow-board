<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED DEP-MODULES
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	// IMPORTED ENVS
	import { goto, invalidateAll } from '$app/navigation';
	// IMPORTED MODULES
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import SettingsShell from '#lib/settings/SettingsShell.svelte';
	import { ApiError, api, deletePicture, newKey, putPicture } from '#lib/board/api.js';
	import { addDays, formatUtcDate } from '#lib/board/when.js';
	import { ORG_DELETE_GRACE_DAYS, sameOrgName } from '#lib/shared/orgDeletion.js';
	import { ROLE_LABEL, type Role } from '#lib/shared/roles.js';
	import { createFollower } from '#lib/settings/follow.js';
	import AuditLog from '#lib/settings/AuditLog.svelte';
	import EmailSending from '#lib/settings/EmailSending.svelte';
	import IdentityHeader from '#lib/settings/IdentityHeader.svelte';
	import PalettePicker from '#lib/settings/PalettePicker.svelte';
	import Section from '#lib/settings/Section.svelte';
	import MembersSection from '#lib/settings/members/MembersSection.svelte';
	import OrgTile from '#lib/board/OrgTile.svelte';
	import OrgBackups from '#lib/board/settings/OrgBackups.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import PictureUpload from '#lib/ui/PictureUpload.svelte';
	import Select from '#lib/ui/Select.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Settings from '@lucide/svelte/icons/settings';
	import Palette from '@lucide/svelte/icons/palette';
	import Gauge from '@lucide/svelte/icons/gauge';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	// -- REQUIRED PROPS -- //

	let { data, form }: PageProps = $props();

	// -- TYPES -- //

	type AuditEvents = NonNullable<PageProps['data']['audit']>['events'];

	// -- CONSTANTS -- //

	const TOKEN_DAYS = [7, 14, 30, 60, 90];

	// -- STATES -- //

	let name = $state('');
	let accent = $state<string | null>(null);
	let tokenMaxDays = $state(90);
	let allowGuests = $state(true);
	let status = $state<Record<string, { saving: boolean; saved: boolean; error: string }>>({});
	let extraAudit = $state<AuditEvents>([]);
	let nextAudit = $state<number | null>(null);
	let auditProject = $state('');
	/** True while the audit log loads a project or the next page. */
	let auditLoading = $state(false);
	/** Why the last audit load failed, or an empty string. */
	let auditError = $state('');
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
			// The promise toast already shows the failure and nothing was changed
		}
	}

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
		auditLoading = true;
		try {
			const more = await api<{ events: AuditEvents; next: number | null }>(org, `/audit?${params}`);
			extraAudit = [...extraAudit, ...more.events];
			nextAudit = more.next;
		} catch (e) {
			auditError =
				e instanceof ApiError
					? e.message
					: 'The changes of this organisation could not be read. Check your connection and try again.';
		} finally {
			auditLoading = false;
		}
	}

	async function filterAudit(project: string) {
		auditProject = project;
		const params = new SvelteURLSearchParams({ limit: '25' });
		if (project) params.set('project', project);
		auditError = '';
		auditLoading = true;
		// The old rows go at once, so the skeleton shows while the project loads
		extraAudit = [];
		filtered = true;
		try {
			const first = await api<{ events: AuditEvents; next: number | null }>(
				org,
				`/audit?${params}`
			);
			extraAudit = first.events;
			nextAudit = first.next;
			filtered = true;
		} catch (e) {
			auditError =
				e instanceof ApiError
					? e.message
					: 'The changes of this organisation could not be read. Check your connection and try again.';
		} finally {
			auditLoading = false;
		}
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
				previewName={data.org.name}
				onupload={(f) => uploadLogo(f)}
				onremove={() => act(() => deletePicture(`/orgs/${org}/logo`), 'Logo removed.')}
			>
				{#snippet preview(size)}<OrgTile name={data.org.name} logo={s.logo} {size} />{/snippet}
			</PictureUpload>
		</Section>

		<!-- MEMBERS AND ROLES: ITS OWN SECTION COMPONENT, THE PAGE ONLY HANDS IT WHAT IT LOADED -->
		<MembersSection
			{org}
			viewerRole={data.org.role as Role}
			viewerId={data.me.id}
			canManage={can}
			allowGuests={s.settings.allowGuestInvites}
			members={data.members}
			invites={data.invites}
			projects={data.projects}
			projectRoles={data.projectRoles}
			onchange={() => invalidateAll()}
		/>

		<!-- EMAIL SENDING: THE PROVIDER, WHAT GOES THROUGH IT AND THE TEST MESSAGE -->
		<EmailSending email={data.email} {can} {form} group="Delivery" />

		{#if can}
			<!-- BACKUPS: THE SUMMARY, THE HISTORY AND ITS DOWNLOAD AND DELETE LIVE IN THEIR OWN COMPONENT -->
			<OrgBackups backups={data.backups} {org} group="Delivery" />

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

			<!-- AUDIT LOG: READ ONLY, A TIMELINE GROUPED BY DAY -->
			<AuditLog
				events={shownEvents}
				projects={data.projects}
				project={auditProject}
				hasMore={nextAudit !== null}
				loading={auditLoading}
				error={auditError}
				onfilter={filterAudit}
				onmore={moreAudit}
				onretry={() => filterAudit(auditProject)}
				group="Safety"
			/>
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
			days. Its tokens and connected apps stop working now.
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
