<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { invalidateAll } from '$app/navigation';
	// -- MODULES -- //
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import SettingsShell from '#lib/settings/SettingsShell.svelte';
	import { ApiError, api } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import { createFollower } from '#lib/settings/follow.js';
	import PalettePicker from '#lib/settings/PalettePicker.svelte';
	import { postAction } from '#lib/settings/post.js';
	import Section from '#lib/settings/Section.svelte';
	import { applyMode, type ModeChoice } from '#lib/theme/mode.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Mark from '#lib/ui/Mark.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Select from '#lib/ui/Select.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- CONSTANTS -- //

	const METHOD_LABEL: Record<string, string> = {
		credential: 'Email and password',
		google: 'Google'
	};
	const TARGETS = [
		{ value: '', label: 'No preference' },
		{ value: 'dev', label: 'Dev server' },
		{ value: 'preview', label: 'Build preview' },
		{ value: 'deployed', label: 'Deployed site' }
	];

	// -- STATES -- //

	let name = $state('');
	let current = $state('');
	let next = $state('');
	let mode = $state<ModeChoice>('system');
	let accent = $state<string | null>(null);
	let target = $state('');
	let backupAlerts = $state(true);
	let publishPaused = $state(true);
	let status = $state<Record<string, { saving: boolean; saved: boolean; error: string }>>({});

	// -- REACTIVE STATES -- //

	const prefs = $derived(data.prefs);
	const dirty = $derived({
		profile: name.trim() !== data.me.name,
		password: current !== '' && next !== '',
		appearance: mode !== prefs.themeMode || (accent ?? null) !== (prefs.accent ?? null),
		checks: target !== prefs.checkTarget,
		notifications:
			backupAlerts !== prefs.notifications.backupAlerts ||
			publishPaused !== prefs.notifications.publishPaused
	});

	// -- FUNCTIONS -- //

	const st = (id: string) => status[id] ?? { saving: false, saved: false, error: '' };

	const follow = createFollower();
	$effect(() => {
		follow('name', data.me.name, (v) => (name = v));
		follow('mode', prefs.themeMode, (v) => (mode = v));
		follow('accent', prefs.accent, (v) => (accent = v));
		follow('target', prefs.checkTarget, (v) => (target = v));
		follow('backupAlerts', prefs.notifications.backupAlerts, (v) => (backupAlerts = v));
		follow('publishPaused', prefs.notifications.publishPaused, (v) => (publishPaused = v));
	});

	async function run(
		id: string,
		action: string,
		fields: Record<string, string>,
		after?: () => void
	) {
		status[id] = { saving: true, saved: false, error: '' };
		const r = await postAction(action, fields);
		if (r.ok) {
			after?.();
			await invalidateAll();
			status[id] = { saving: false, saved: true, error: '' };
		} else status[id] = { saving: false, saved: false, error: r.message };
	}

	/** The preferences are one row, so a section sends its own fields and the saved values of the others. */
	const prefsFields = (own: Record<string, string>) => ({
		themeMode: prefs.themeMode,
		accent: prefs.accent ?? '',
		checkTarget: prefs.checkTarget,
		...(prefs.notifications.backupAlerts ? { backupAlerts: 'on' } : {}),
		...(prefs.notifications.publishPaused ? { publishPaused: 'on' } : {}),
		...own
	});

	async function endSession(token: string) {
		if (
			!(await askConfirm({
				title: 'End this session?',
				body: 'The device using it is signed out at once.',
				confirmLabel: 'End the session'
			}))
		)
			return;
		const r = await postAction('revoke', { token });
		if (r.ok) {
			toast.success('Session ended.');
			await invalidateAll();
		} else toast.error(r.message);
	}

	async function endOthers() {
		if (
			!(await askConfirm({
				title: 'End every other session?',
				body: 'Every other device is signed out at once. This one stays signed in.',
				confirmLabel: 'End them'
			}))
		)
			return;
		const r = await postAction('revokeOthers', {});
		if (r.ok) {
			toast.success('Every other session was ended.');
			await invalidateAll();
		} else toast.error(r.message);
	}

	async function revokeTool(org: string, id: string) {
		if (
			!(await askConfirm({
				title: 'Revoke this tool?',
				body: 'It stops working at once. To use it again it has to connect again.',
				confirmLabel: 'Revoke'
			}))
		)
			return;
		try {
			await api(org, `/tokens/${id}`, { method: 'DELETE' });
			toast.success('Revoked. That tool stops working now.');
			await invalidateAll();
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'It could not be revoked.');
		}
	}
</script>

<svelte:head><title>Your settings</title></svelte:head>

<PageFrame tag="main" class="pb-12">
	<header class="flex items-center justify-between gap-3">
		<a href="/" class="flex items-center gap-2 font-bold"><Mark size={24} /> agent-flow-board</a>
		<a class="text-sm text-accent-text hover:underline" href="/">All organisations</a>
	</header>
	<PageHeader title="Your settings" context="Each section saves on its own." />

	<SettingsShell>
		<Section
			id="profile"
			title="Profile"
			text="The name people see next to your changes."
			dirty={dirty.profile}
			saving={st('profile').saving}
			saved={st('profile').saved}
			error={st('profile').error}
			onsave={() => run('profile', 'profile', { name: name.trim() })}
		>
			<TextField label="Your name" bind:value={name} data-testid="profile-name" />
			<div class="text-xs text-muted">Signed in as {data.me.email}</div>
		</Section>

		<Section
			id="signin"
			title="How you sign in"
			text="Your methods, and your password."
			dirty={dirty.password}
			saving={st('signin').saving}
			saved={st('signin').saved}
			error={st('signin').error}
			saveLabel="Change password"
			onsave={() =>
				run('signin', 'password', { current, next }, () => {
					current = '';
					next = '';
				})}
		>
			<div class="flex flex-wrap gap-2">
				{#each data.methods as m (m)}<Badge tone="info">{METHOD_LABEL[m] ?? m}</Badge>{/each}
			</div>
			{#if data.methods.includes('credential')}
				<TextField
					label="Current password"
					type="password"
					bind:value={current}
					autocomplete="current-password"
					data-testid="password-current"
				/>
				<TextField
					label="New password"
					type="password"
					bind:value={next}
					autocomplete="new-password"
					hint="At least 10 characters. Changing it signs you out everywhere else."
					data-testid="password-new"
				/>
			{:else}
				<div class="text-sm text-muted">
					You sign in with Google, so there is no password to change here.
				</div>
			{/if}
		</Section>

		<Section
			id="sessions"
			title="Where you are signed in"
			text="End a session you do not recognise. It stops working at once."
		>
			<ul class="rounded-lg border border-line" data-testid="session-list">
				{#each data.sessions as s (s.token)}
					<li
						class="flex min-h-12 flex-wrap items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
						data-item
						data-testid="session"
					>
						<span class="min-w-0 flex-1 text-sm">
							<span class="block truncate">{s.userAgent || 'A browser'}</span>
							<span class="block text-xs text-muted">{s.ipAddress}, started {ago(s.createdAt)}</span
							>
						</span>
						{#if s.current}
							<Badge tone="success">this one</Badge>
						{:else}
							<Button size="sm" variant="ghost" onclick={() => endSession(s.token)}>End it</Button>
						{/if}
					</li>
				{/each}
			</ul>
			{#if data.sessions.length > 1}
				<div>
					<Button size="sm" onclick={endOthers} data-testid="end-others"
						>End every other session</Button
					>
				</div>
			{/if}
		</Section>

		<Section
			id="tools"
			title="Connected tools and tokens"
			text="The coding tools and tokens that act as you. Revoke one and it stops at once."
		>
			{#if data.tools.length === 0}
				<div class="text-sm text-muted">
					No tool is connected. <a class="text-accent-text hover:underline" href="/connect"
						>Connect one.</a
					>
				</div>
			{:else}
				<ul class="rounded-lg border border-line" data-testid="tool-list">
					{#each data.tools as t (t.id)}
						<li
							class="flex min-h-12 flex-wrap items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
							data-item
							data-testid="tool"
						>
							<span class="min-w-0 flex-1 text-sm">
								{t.name}
								<span class="text-xs text-muted"
									>{t.orgName}, {t.kind}, expires {ago(t.expiresAt)}</span
								>
							</span>
							<Button size="sm" variant="ghost" onclick={() => revokeTool(t.org, t.id)}
								>Revoke</Button
							>
						</li>
					{/each}
				</ul>
				<div>
					<a class="text-sm text-accent-text hover:underline" href="/connect"
						>Connect another tool</a
					>
				</div>
			{/if}
		</Section>

		<Section
			id="appearance"
			title="Appearance"
			text="Light, dark or the setting of your device, and an accent colour of your own."
			dirty={dirty.appearance}
			saving={st('appearance').saving}
			saved={st('appearance').saved}
			error={st('appearance').error}
			onsave={() =>
				run('appearance', 'prefs', prefsFields({ themeMode: mode, accent: accent ?? '' }))}
		>
			<SegmentedControl
				label="Theme"
				bind:value={mode}
				options={[
					{ value: 'light', label: 'Light' },
					{ value: 'dark', label: 'Dark' },
					{ value: 'system', label: 'System' }
				]}
				onchange={(v) => applyMode(v as ModeChoice)}
			/>
			<PalettePicker bind:value={accent} label="Your accent colour" />
			<div class="text-xs text-muted">
				Your own accent replaces the organisation's colour for you only.
			</div>
		</Section>

		<Section
			id="checks"
			title="Browser checks"
			text="Where you want checks to run by default."
			dirty={dirty.checks}
			saving={st('checks').saving}
			saved={st('checks').saved}
			error={st('checks').error}
			onsave={() => run('checks', 'prefs', prefsFields({ checkTarget: target }))}
		>
			<Select
				label="Run checks on"
				value={target}
				options={TARGETS}
				onchange={(v) => (target = v)}
				class="w-56"
			/>
		</Section>

		<Section
			id="notifications"
			title="Email notifications"
			text="What this server may email you about."
			dirty={dirty.notifications}
			saving={st('notifications').saving}
			saved={st('notifications').saved}
			error={st('notifications').error}
			onsave={() =>
				run(
					'notifications',
					'prefs',
					prefsFields({
						...(backupAlerts ? { backupAlerts: 'on' } : { backupAlerts: '' }),
						...(publishPaused ? { publishPaused: 'on' } : { publishPaused: '' })
					})
				)}
		>
			<Switch
				label="Backup problems"
				hint="When a nightly backup fails or is late, for organisations you own."
				bind:checked={backupAlerts}
			/>
			<Switch
				label="Publishing paused"
				hint="When automatic publishing stops after repeated failures, for projects you manage."
				bind:checked={publishPaused}
			/>
		</Section>
	</SettingsShell>
</PageFrame>
