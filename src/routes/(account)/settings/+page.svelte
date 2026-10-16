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
	import { postAction } from '#lib/settings/post.js';
	import Section from '#lib/settings/Section.svelte';
	import { live, setLiveMode } from '#lib/theme/live.svelte.js';
	import type { ResolvedMode } from '#lib/theme/mode.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Select from '#lib/ui/Select.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	// -- DEP-COMPONENTS -- //
	import User from '@lucide/svelte/icons/user';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
	import Plug from '@lucide/svelte/icons/plug';
	import Palette from '@lucide/svelte/icons/palette';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Bell from '@lucide/svelte/icons/bell';

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
	let target = $state('');
	let backupAlerts = $state(true);
	let publishPaused = $state(true);
	let status = $state<Record<string, { saving: boolean; saved: boolean; error: string }>>({});

	// -- REACTIVE STATES -- //

	const prefs = $derived(data.prefs);
	const dirty = $derived({
		profile: name.trim() !== data.me.name,
		password: current !== '' && next !== '',
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
		themeMode: live.mode,
		checkTarget: prefs.checkTarget,
		...(prefs.notifications.backupAlerts ? { backupAlerts: 'on' } : {}),
		...(prefs.notifications.publishPaused ? { publishPaused: 'on' } : {}),
		...own
	});

	/** One server action as a promise toast; a refusal shows its own message and stays until dismissed. */
	async function runAction(
		name: string,
		body: Record<string, string>,
		loading: string,
		success: string
	) {
		try {
			await toast.promise(
				postAction(name, body).then((r) => {
					if (!r.ok) throw new Error(r.message);
					return r;
				}),
				{ loading, success, error: (e) => (e instanceof Error ? e.message : 'That did not work.') }
			);
			await invalidateAll();
		} catch {
			// The promise toast already shows the failure
		}
	}

	async function endSession(token: string) {
		if (
			!(await askConfirm({
				title: 'End this session?',
				body: 'The device using it is signed out at once.',
				confirmLabel: 'End the session'
			}))
		)
			return;
		await runAction('revoke', { token }, 'Ending the session...', 'Session ended.');
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
		await runAction(
			'revokeOthers',
			{},
			'Ending the other sessions...',
			'Every other session was ended.'
		);
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
			await toast.promise(api(org, `/tokens/${id}`, { method: 'DELETE' }), {
				loading: 'Revoking...',
				success: 'Revoked. That tool stops working now.',
				error: (e) => (e instanceof ApiError ? e.message : 'It could not be revoked.')
			});
			await invalidateAll();
		} catch {
			// The promise toast already shows the failure
		}
	}
</script>

<svelte:head><title>Your settings</title></svelte:head>

<PageFrame class="pb-12">
	<PageHeader title="Your settings" context="Each section saves on its own." />

	<SettingsShell>
		<Section
			id="profile"
			icon={User}
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
			icon={KeyRound}
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
			icon={MonitorSmartphone}
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
			icon={Plug}
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
			icon={Palette}
			title="My appearance"
			text="Light or dark, only for you. It switches and saves as you pick, and the switch in the top bar does the same."
		>
			<SegmentedControl
				label="Theme"
				value={live.mode}
				options={[
					{ value: 'light', label: 'Light' },
					{ value: 'dark', label: 'Dark' }
				]}
				onchange={(v) => setLiveMode(v as ResolvedMode)}
			/>
			<div class="text-xs text-muted">
				The accent colour comes from the organisation. An admin sets it in Organisation settings.
			</div>
		</Section>

		<Section
			id="checks"
			icon={ShieldCheck}
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
			icon={Bell}
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
