<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { PageProps } from './$types';
	// IMPORTED ENVS
	import { invalidate, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	// IMPORTED MODULES
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import PictureUpload from '#lib/ui/PictureUpload.svelte';
	import SettingsShell from '#lib/settings/SettingsShell.svelte';
	import { ApiError, api, deletePicture, newKey, putPicture } from '#lib/board/api.js';
	import EventList from '#lib/board/EventList.svelte';
	import ProjectTile from '#lib/board/ProjectTile.svelte';
	import TrashPanel from '#lib/board/TrashPanel.svelte';
	import { canon, createFollower } from '#lib/settings/follow.js';
	import {
		savedStreams,
		streamsProblem,
		withIds,
		withoutIds,
		type StreamRow
	} from '#lib/board/streams.js';
	import Section from '#lib/settings/Section.svelte';
	import StreamsEditor from '#lib/settings/StreamsEditor.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Settings from '@lucide/svelte/icons/settings';
	import Layers from '@lucide/svelte/icons/layers';
	import Activity from '@lucide/svelte/icons/activity';
	import Download from '@lucide/svelte/icons/download';
	import Trash from '@lucide/svelte/icons/trash';
	import ListFilter from '@lucide/svelte/icons/list-filter';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- STATES -- //

	let name = $state('');
	let webApp = $state(false);
	let streams = $state<StreamRow[]>([]);
	let status = $state<Record<string, { saving: boolean; saved: boolean; error: string }>>({});
	let retryingActivity = $state(false);

	// -- FUNCTIONS -- //

	/** Reads the activity list again after it failed to load. */
	async function retryActivity() {
		retryingActivity = true;
		try {
			await invalidate('afb:settings');
		} finally {
			retryingActivity = false;
		}
	}

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const p = $derived(data.project);
	const can = $derived(data.canManage);
	const tab = $derived(page.url.searchParams.get('tab'));
	const canWrite = $derived(can);
	const dirty = $derived(
		p
			? {
					general: name.trim() !== p.name || webApp !== p.webApp,
					streams: canon(savedStreams(streams)) !== canon(p.streams)
				}
			: {
					general: false,
					streams: false
				}
	);

	// Why the streams cannot be saved yet, in plain words, or null
	const streamsIssue = $derived(streamsProblem(withoutIds(streams)));

	// -- FUNCTIONS -- //

	const st = (id: string) => status[id] ?? { saving: false, saved: false, error: '' };

	// The fields follow the saved values whenever the page data is replaced
	const follow = createFollower();
	$effect(() => {
		if (!p) return;
		follow('name', p.name, (v) => (name = v));
		follow('webApp', p.webApp, (v) => (webApp = v));
		follow('streams', p.streams, (v) => (streams = withIds(v)));
	});

	async function save(id: string, path: string, body: Record<string, unknown>, method = 'PATCH') {
		status[id] = { saving: true, saved: false, error: '' };
		try {
			// The toast wraps the raw write, so a refusal rejects it and no success toast shows
			await toast.promise(api(org, path, { method, body, key: newKey() }), {
				id: `save-${id}`,
				loading: 'Saving...',
				success: 'Saved.',
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
		await invalidate('afb:settings');
		await invalidate('afb:project');
		status[id] = { saving: false, saved: true, error: '' };
	}

	/** Sets or removes the logo at once: a picture is not a form field, so it has no Save button. The sidebar is read again too. */
	async function changeLogo(work: () => Promise<void>, ok: string) {
		try {
			await toast.promise(work(), {
				loading: 'Working on it...',
				success: ok,
				error: (e) => (e instanceof ApiError ? e.message : 'That did not work.')
			});
			await invalidateAll();
		} catch {
			// The promise toast already shows the failure
		}
	}

	const patchProject = (id: string, body: Record<string, unknown>) =>
		save(id, `/projects/${key}`, body);

	/** Undoes everything one agent session changed, after a confirmation that names what happens. */
	async function undoSession(sessionId: string | null) {
		if (!sessionId) return;
		if (
			!(await askConfirm({
				title: 'Undo this whole session?',
				body: 'Everything the session changed is put back, newest change first, until one cannot be undone safely.',
				confirmLabel: 'Undo it all'
			}))
		)
			return;
		try {
			await toast.promise(api(org, `/sessions/${sessionId}/undo`, { method: 'POST', body: {} }), {
				loading: 'Undoing the session...',
				success: 'Everything that session changed is undone.',
				error: (e) => (e instanceof ApiError ? e.message : 'The session could not be undone.')
			});
			await invalidate('afb:project');
		} catch {
			// The promise toast already shows the failure
		}
	}
</script>

<svelte:head><title>Project settings, {p?.name ?? ''}</title></svelte:head>

<PageFrame class="pb-12">
	<PageHeader
		title="Project settings"
		context={can
			? 'Each section saves on its own.'
			: 'You can look at these. An admin or owner changes them.'}
	/>

	<SettingsShell>
		{#if !p}
			<EmptyState
				kind="locked"
				title="Not available"
				text="You do not have access to this project."
			/>
		{:else}
			<Section
				id="general"
				icon={Settings}
				title="General"
				text="The name and logo people see in the project list."
				dirty={dirty.general}
				saving={st('general').saving}
				saved={st('general').saved}
				error={st('general').error}
				readonly={!can}
				onsave={() => patchProject('general', { name: name.trim(), webApp })}
			>
				<TextField
					label="Project name"
					hint={`Its key is ${p.key} and does not change.`}
					bind:value={name}
					disabled={!can}
					data-testid="project-name-input"
				/>

				<PictureUpload
					label="Logo"
					previewName={p.name}
					removeLabel="Remove the logo"
					hasPicture={Boolean(p.logoV)}
					canEdit={Boolean(can)}
					testid="project-logo"
					onupload={(f) =>
						changeLogo(() => putPicture(`/orgs/${org}/projects/${key}/logo`, f), 'Logo saved.')}
					onremove={() =>
						changeLogo(() => deletePicture(`/orgs/${org}/projects/${key}/logo`), 'Logo removed.')}
				>
					{#snippet preview(size)}<ProjectTile
							id={p.id}
							projectKey={p.key}
							logoV={p.logoV}
							{size}
						/>{/snippet}
				</PictureUpload>

				<Switch
					label="This project is a web app"
					hint="Web apps can run browser checks and UI shots through the agent-flow-board bridge."
					bind:checked={webApp}
					disabled={!can}
				/>
			</Section>

			<Section
				id="streams"
				icon={Layers}
				title="Streams and scopes"
				text="How this project sorts its items: the kind of work, and the part of the product it touches."
				dirty={dirty.streams}
				blocked={Boolean(streamsIssue)}
				saving={st('streams').saving}
				saved={st('streams').saved}
				error={streamsIssue ?? st('streams').error}
				readonly={!can}
				onsave={() =>
					patchProject('streams', {
						streams: savedStreams(streams)
					})}
			>
				<StreamsEditor bind:rows={streams} usage={data.usage} can={Boolean(can)} />
			</Section>

			<Section
				id="activity"
				icon={Activity}
				title="Activity"
				text="Everything that changed in this project, newest first. Most changes can be undone."
			>
				{#if tab === 'activity' && retryingActivity}
					<!-- FIVE SKELETON ROWS WHILE THE LIST IS READ AGAIN -->
					<div class="rounded-xl border border-line bg-surface p-3" data-testid="activity-loading">
						<Skeleton variant="row" lines={5} />
					</div>
				{:else if tab === 'activity' && data.activityFailed}
					<div class="rounded-xl border border-line bg-surface" data-testid="activity-error">
						<ErrorState
							title="The activity did not load"
							message="The changes of this project could not be read. Check your connection and try again."
							onretry={retryActivity}
						/>
					</div>
				{:else if tab === 'activity' && data.activity}
					<div class="flex flex-col gap-3">
						{#if data.sessionId}
							<div
								class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-accent/35 bg-accent-soft px-4 py-3 max-sm:px-3"
								data-testid="session-notice"
							>
								<ListFilter size={16} class="shrink-0 text-accent-text" />
								<p class="min-w-0 flex-1 text-sm font-medium text-accent-text">
									Only what one agent session changed.
								</p>
								<div class="flex items-center gap-3">
									<a
										class="text-sm text-accent-text hover:underline"
										href={`/${org}/${key}/settings?tab=activity`}>Show everything</a
									>
									{#if canWrite}<Button
											size="sm"
											variant="danger"
											onclick={() => undoSession(data.sessionId)}>Undo this session</Button
										>{/if}
								</div>
							</div>
						{/if}
						<EventList
							events={data.activity.events}
							{org}
							refs={data.activity.refs}
							linkBase={`/${org}/${key}`}
							canUndo={canWrite}
							scoped={Boolean(data.sessionId)}
							onchanged={() => invalidate('afb:project')}
							onundosession={(id) => undoSession(id)}
						/>
					</div>
				{/if}
			</Section>

			<Section
				id="trash"
				icon={Trash}
				title="Trash"
				text="Things stay here for 30 days, then they are removed for good."
			>
				{#if tab === 'trash' && data.trash}
					<TrashPanel {org} projectKey={key} trash={data.trash.list} denied={data.trash.denied} />
				{/if}
			</Section>

			<Section
				id="export"
				icon={Download}
				title="Export"
				text="Download this project's public items. Private items are never included."
			>
				<div class="flex flex-wrap gap-2">
					<Button href={`/${org}/${key}/export.json`} data-testid="export-json"
						>Download the snapshot (JSON)</Button
					>
					<Button href={`/${org}/${key}/export.md`} data-testid="export-md"
						>Download as Markdown</Button
					>
				</div>
			</Section>
		{/if}
	</SettingsShell>
</PageFrame>
