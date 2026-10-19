<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { invalidate, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import PictureUpload from '#lib/ui/PictureUpload.svelte';
	import SettingsShell from '#lib/settings/SettingsShell.svelte';
	import { ApiError, api, deletePicture, newKey, putPicture } from '#lib/board/api.js';
	import ProjectTile from '#lib/board/ProjectTile.svelte';
	import BrowserChecks from '#lib/settings/BrowserChecks.svelte';
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
	import Select from '#lib/ui/Select.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Settings from '@lucide/svelte/icons/settings';
	import Layers from '@lucide/svelte/icons/layers';
	import Bot from '@lucide/svelte/icons/bot';
	import GitBranch from '@lucide/svelte/icons/git-branch';
	import Activity from '@lucide/svelte/icons/activity';
	import Download from '@lucide/svelte/icons/download';
	import Trash from '@lucide/svelte/icons/trash';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- CONSTANTS -- //

	const DELAYS = [1, 5, 10, 30, 60, 240, 1440];
	const STALE = [1, 2, 3, 5, 7, 14, 30];
	const DAYS = [
		{ n: 1, label: 'Mon' },
		{ n: 2, label: 'Tue' },
		{ n: 3, label: 'Wed' },
		{ n: 4, label: 'Thu' },
		{ n: 5, label: 'Fri' },
		{ n: 6, label: 'Sat' },
		{ n: 0, label: 'Sun' }
	];
	const ZONES = [
		'UTC',
		'Europe/London',
		'Europe/Berlin',
		'America/New_York',
		'America/Los_Angeles',
		'Asia/Singapore',
		'Asia/Manila',
		'Australia/Sydney'
	];

	// -- STATES -- //

	let name = $state('');
	let webApp = $state(false);
	let streams = $state<StreamRow[]>([]);
	let mayComplete = $state(true);
	let stale = $state(3);
	let auto = $state(false);
	let delay = $state(10);
	let windowed = $state(false);
	let days = $state<number[]>([1, 2, 3, 4, 5]);
	let from = $state('09:00');
	let to = $state('18:00');
	let zone = $state('UTC');
	let status = $state<Record<string, { saving: boolean; saved: boolean; error: string }>>({});

	// -- FUNCTIONS -- //

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const p = $derived(data.project);
	const can = $derived(data.canManage);
	const link = $derived(data.publish?.link ?? null);
	const dirty = $derived(
		p
			? {
					general: name.trim() !== p.name || webApp !== p.webApp,
					streams: canon(savedStreams(streams)) !== canon(p.streams),
					agents: mayComplete !== p.agentsMayComplete,
					tracking: stale !== p.staleDays,
					publish: link
						? auto !== link.autoPublish ||
							delay !== link.delayMinutes ||
							canon(scheduleValue()) !== canon(link.schedule ?? null)
						: false
				}
			: {
					general: false,
					streams: false,
					agents: false,
					tracking: false,
					publish: false
				}
	);

	// Why the streams cannot be saved yet, in plain words, or null
	const streamsIssue = $derived(streamsProblem(withoutIds(streams)));

	// -- FUNCTIONS -- //

	const st = (id: string) => status[id] ?? { saving: false, saved: false, error: '' };

	function scheduleValue() {
		return windowed ? { days: [...days].sort((a, b) => a - b), from, to, timezone: zone } : null;
	}

	// The fields follow the saved values whenever the page data is replaced
	const follow = createFollower();
	$effect(() => {
		if (!p) return;
		follow('name', p.name, (v) => (name = v));
		follow('webApp', p.webApp, (v) => (webApp = v));
		follow('streams', p.streams, (v) => (streams = withIds(v)));
		follow('mayComplete', p.agentsMayComplete, (v) => (mayComplete = v));
		follow('stale', p.staleDays, (v) => (stale = v));
		if (link) {
			follow('auto', link.autoPublish, (v) => (auto = v));
			follow('delay', link.delayMinutes, (v) => (delay = v));
			follow('schedule', link.schedule, (v) => {
				windowed = v !== null;
				if (v) {
					days = [...v.days];
					from = v.from;
					to = v.to;
					zone = v.timezone;
				}
			});
		}
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

	function toggleDay(n: number) {
		days = days.includes(n) ? days.filter((d) => d !== n) : [...days, n];
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
					hint="Saves as soon as you choose a file. A PNG, JPEG or WebP under 200 KB"
					removeLabel="Remove the logo"
					hasPicture={Boolean(p.logoV)}
					canEdit={Boolean(can)}
					testid="project-logo"
					onupload={(f) =>
						changeLogo(() => putPicture(`/orgs/${org}/projects/${key}/logo`, f), 'Logo saved.')}
					onremove={() =>
						changeLogo(() => deletePicture(`/orgs/${org}/projects/${key}/logo`), 'Logo removed.')}
				>
					{#snippet preview()}<ProjectTile
							id={p.id}
							projectKey={p.key}
							logoV={p.logoV}
							size={40}
						/>{/snippet}
				</PictureUpload>

				<Switch
					label="This project is a web app"
					hint="Web apps can run browser checks and UI shots through the afb-checks tool."
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
				id="agents"
				icon={Bot}
				title="Agents and closing"
				text="Whether an agent may set an item to COMPLETED. Off keeps closing for people."
				dirty={dirty.agents}
				saving={st('agents').saving}
				saved={st('agents').saved}
				error={st('agents').error}
				readonly={!can}
				onsave={() => patchProject('agents', { agentsMayComplete: mayComplete })}
			>
				<Switch
					label="Agents may set COMPLETED"
					hint="An agent still has to confirm closing an item it is not working on."
					bind:checked={mayComplete}
					disabled={!can}
				/>
			</Section>

			<Section
				id="publishing"
				icon={GitBranch}
				title="GitHub publishing"
				text="A readable reference copy of this project in a repository. It is not a backup."
				dirty={dirty.publish}
				saving={st('publishing').saving}
				saved={st('publishing').saved}
				error={st('publishing').error}
				readonly={!can || !link}
				onsave={() =>
					save('publishing', `/projects/${key}/publish/settings`, {
						autoPublish: auto,
						delayMinutes: delay,
						schedule: scheduleValue()
					})}
			>
				{#if !data.publish?.configured}
					<div class="text-sm text-muted">GitHub publishing is not set up on this server.</div>
				{:else if !link}
					<div class="text-sm text-muted">
						No repository is connected. <a
							class="text-accent-text hover:underline"
							href={`/${org}/${key}/publish`}>Connect one on the Publish page.</a
						>
					</div>
				{:else}
					<div class="text-sm">
						Publishing to <span class="font-mono text-xs">{link.repo}</span>.
						<a class="text-accent-text hover:underline" href={`/${org}/${key}/publish`}
							>Open the Publish page</a
						>
					</div>
					{#if link.pausedReason}
						<Notice tone="warning"
							>Automatic publish is paused. {link.pausedReason} Turn it on again to resume.</Notice
						>
					{/if}
					<Switch
						label="Publish automatically"
						hint="After a change, after the delay below, unless you cancel it."
						bind:checked={auto}
						disabled={!can}
					/>
					<Select
						label="Wait this long after a change"
						value={String(delay)}
						options={DELAYS.map((d) => ({
							value: String(d),
							label:
								d >= 60
									? `${d / 60} ${d === 60 ? 'hour' : 'hours'}`
									: `${d} ${d === 1 ? 'minute' : 'minutes'}`
						}))}
						onchange={(v) => (delay = Number(v))}
						disabled={!can}
						class="w-48"
					/>
					<Switch
						label="Only publish inside a time window"
						bind:checked={windowed}
						disabled={!can}
					/>
					{#if windowed}
						<div class="flex flex-wrap gap-1.5" role="group" aria-label="Days of the week">
							{#each DAYS as d (d.n)}
								<button
									type="button"
									role="checkbox"
									aria-checked={days.includes(d.n)}
									disabled={!can}
									onclick={() => toggleDay(d.n)}
									class="min-h-11 min-w-12 cursor-pointer rounded-lg border border-line bg-surface px-2 text-xs font-medium text-muted hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50 aria-checked:border-accent aria-checked:bg-accent-soft aria-checked:text-accent-text"
									>{d.label}</button
								>
							{/each}
						</div>
						<div class="flex flex-wrap items-end gap-2">
							<TextField label="From" type="time" bind:value={from} disabled={!can} class="w-36" />
							<TextField label="To" type="time" bind:value={to} disabled={!can} class="w-36" />
							<Select
								label="Time zone"
								value={zone}
								options={ZONES.map((z) => ({ value: z, label: z }))}
								onchange={(v) => (zone = v)}
								disabled={!can}
								class="w-56"
							/>
						</div>
					{/if}
				{/if}
			</Section>

			<Section
				id="tracking"
				icon={Activity}
				title="Tracking"
				text="When an item in progress with no activity counts as quiet on the health page."
				dirty={dirty.tracking}
				saving={st('tracking').saving}
				saved={st('tracking').saved}
				error={st('tracking').error}
				readonly={!can}
				onsave={() => patchProject('tracking', { staleDays: stale })}
			>
				<Select
					label="Quiet after"
					value={String(stale)}
					options={STALE.map((d) => ({
						value: String(d),
						label: `${d} ${d === 1 ? 'day' : 'days'}`
					}))}
					onchange={(v) => (stale = Number(v))}
					disabled={!can}
					class="w-48"
				/>
			</Section>

			<BrowserChecks
				{org}
				projectKey={key}
				webApp={p.webApp}
				defaultTarget={p.defaultTarget}
				tools={data.tools}
				can={can ?? false}
			/>

			<Section
				id="trash"
				icon={Trash}
				title="Trash"
				text="Items, tasks and files you remove stay for 30 days."
			>
				<div>
					<Button href={`/${org}/${key}/trash`} data-testid="open-trash"
						>Open the trash <ArrowRight size={16} /></Button
					>
				</div>
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
