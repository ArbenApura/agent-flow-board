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
	import { parseDevice } from '#lib/board/device.js';
	import { daysUntil, formatUtcDate } from '#lib/board/when.js';
	import IdentityHeader from '#lib/settings/IdentityHeader.svelte';
	import ModePreview from '#lib/settings/ModePreview.svelte';
	import Section from '#lib/settings/Section.svelte';
	import SettingsRow from '#lib/settings/SettingsRow.svelte';
	import {
		CONTINUE_MODE_LABEL,
		CONTINUE_MODES,
		CONTINUE_TOOLS,
		buildCommand,
		commandPrompt,
		effectiveMode,
		parseMode,
		parseTool,
		toolOf,
		type ContinueMode,
		type ContinueToolId
	} from '#lib/shared/continue.js';
	import { live, setLiveMode } from '#lib/theme/live.svelte.js';
	import type { ResolvedMode } from '#lib/theme/mode.js';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import GoogleLogo from '#lib/ui/GoogleLogo.svelte';
	import PasswordStrength from '#lib/ui/PasswordStrength.svelte';
	import Select from '#lib/ui/Select.svelte';
	import SelectField from '#lib/ui/SelectField.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import OrgTile from '#lib/board/OrgTile.svelte';
	// -- DEP-COMPONENTS -- //
	import User from '@lucide/svelte/icons/user';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
	import Plug from '@lucide/svelte/icons/plug';
	import Palette from '@lucide/svelte/icons/palette';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Bell from '@lucide/svelte/icons/bell';
	import Check from '@lucide/svelte/icons/check';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import Terminal from '@lucide/svelte/icons/terminal';
	import Tablet from '@lucide/svelte/icons/tablet';

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

	const MODES: { value: ResolvedMode; label: string }[] = [
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' }
	];
	const CONTINUE_TOOL_OPTIONS = CONTINUE_TOOLS.map((t) => ({ value: t.id, label: t.label }));
	const DEVICE_ICON = { desktop: Monitor, phone: Smartphone, tablet: Tablet } as const;

	// -- STATES -- //

	let name = $state('');
	let current = $state('');
	let next = $state('');
	let target = $state('');
	let continueTool = $state<ContinueToolId>('claude-code');
	let continueMode = $state<ContinueMode>('vscode');
	let backupAlerts = $state(true);
	let publishPaused = $state(true);
	let status = $state<Record<string, { saving: boolean; saved: boolean; error: string }>>({});

	// -- REACTIVE STATES -- //

	const prefs = $derived(data.prefs);
	/** The ways the chosen tool can do. Open in VS Code only shows for a tool that has the link. */
	const continueWays = $derived(
		CONTINUE_MODES.filter((m) => m !== 'vscode' || toolOf(continueTool).vscode)
			.filter((m) => m !== 'command' || toolOf(continueTool).command)
			.map((m) => ({ value: m, label: CONTINUE_MODE_LABEL[m] }))
	);
	/** What the chosen pair does, in plain words, with the real command for a command. */
	const continueExample = $derived.by(() => {
		const way = effectiveMode(continueTool, continueMode);
		if (way === 'vscode')
			return 'Opens a Claude chat in VS Code with the prompt typed in. You press Enter to run it.';
		if (way === 'command')
			return `Copies a line like: ${buildCommand(continueTool, commandPrompt('resume', continueTool, 'ABC-20261017-0950') ?? '') ?? ''}`;
		return 'Copies the whole prompt, with the item name and address, to paste into your tool.';
	});
	const orgCount = $derived(data.orgs.length);
	const dirty = $derived({
		profile: name.trim() !== data.me.name,
		password: current !== '' && next !== '',
		checks: target !== prefs.checkTarget,
		continue: continueTool !== data.continueTool || continueMode !== data.continueMode,
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
		follow('continueTool', parseTool(data.continueTool), (v) => (continueTool = v));
		follow('continueMode', parseMode(data.continueMode), (v) => (continueMode = v));
		follow('backupAlerts', prefs.notifications.backupAlerts, (v) => (backupAlerts = v));
		follow('publishPaused', prefs.notifications.publishPaused, (v) => (publishPaused = v));
	});

	/** The logo of the organisation a token belongs to, from the list the layout already loaded. */
	const logoOf = (slug: string) => data.orgs.find((o) => o.slug === slug)?.logo ?? null;
	/** The accent of the organisation a token belongs to, so its tile shows that organisation's colour. */
	const paletteOf = (slug: string) => data.orgs.find((o) => o.slug === slug)?.palette ?? null;

	/** When a token stops working, in words. Inside a week it turns into a warning. */
	function expiry(at: string | Date) {
		const days = daysUntil(at);
		if (days <= 0) return { text: 'expires today', soon: true };
		if (days <= 7) return { text: `expires in ${days} ${days === 1 ? 'day' : 'days'}`, soon: true };
		return { text: `expires ${formatUtcDate(at)}`, soon: false };
	}

	// Arrow keys move the choice between the two previews, as in a native radio group
	function onModeKey(e: KeyboardEvent) {
		if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
		e.preventDefault();
		const next: ResolvedMode = live.mode === 'light' ? 'dark' : 'light';
		setLiveMode(next);
		const radios = (e.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLElement>(
			'[role=radio]'
		);
		radios?.[next === 'light' ? 0 : 1]?.focus();
	}

	/** Saves one section. The toast wraps the raw write, so a refusal rejects it and no success toast shows; the section keeps its inline status. */
	async function run(
		id: string,
		action: string,
		fields: Record<string, string>,
		ok: string,
		after?: () => void
	) {
		status[id] = { saving: true, saved: false, error: '' };
		try {
			await toast.promise(
				postAction(action, fields).then((r) => {
					if (!r.ok) throw new Error(r.message);
					return r;
				}),
				{
					id: `save-${id}`,
					loading: 'Saving...',
					success: ok,
					error: (e) => (e instanceof Error ? e.message : 'That was not saved.')
				}
			);
		} catch (e) {
			status[id] = {
				saving: false,
				saved: false,
				error: e instanceof Error ? e.message : 'That was not saved.'
			};
			return;
		}
		after?.();
		await invalidateAll();
		status[id] = { saving: false, saved: true, error: '' };
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
		<!-- YOU -->
		<Section
			id="profile"
			icon={User}
			group="You"
			title="Profile"
			text="The name people see next to your changes."
			dirty={dirty.profile}
			saving={st('profile').saving}
			saved={st('profile').saved}
			error={st('profile').error}
			onsave={() => run('profile', 'profile', { name: name.trim() }, 'Name saved.')}
		>
			<IdentityHeader title={data.me.name} subtitle={data.me.email}>
				{#snippet lead()}<Avatar name={data.me.name} size={40} />{/snippet}
				<Badge
					>Member of {orgCount}
					{orgCount === 1 ? 'organisation' : 'organisations'}</Badge
				>
			</IdentityHeader>
			<TextField label="Your name" bind:value={name} data-testid="profile-name" />
			<div class="text-xs text-muted">Signed in as {data.me.email}</div>
		</Section>

		<!-- SECURITY -->
		<Section
			id="signin"
			icon={KeyRound}
			group="Security"
			title="How you sign in"
			text="Your methods, and your password."
			dirty={dirty.password}
			saving={st('signin').saving}
			saved={st('signin').saved}
			error={st('signin').error}
			saveLabel="Change password"
			onsave={() =>
				run('signin', 'password', { current, next }, 'Password changed.', () => {
					current = '';
					next = '';
				})}
		>
			<ul class="overflow-hidden rounded-lg border border-line" data-testid="method-list">
				{#each data.methods as m (m)}
					<SettingsRow>
						{#snippet lead()}
							<span
								class="inline-flex size-8 items-center justify-center rounded-md border border-line bg-surface text-muted"
								aria-hidden="true"
							>
								{#if m === 'google'}<GoogleLogo />{:else}<KeyRound size={16} />{/if}
							</span>
						{/snippet}
						<span class="block font-medium text-ink">{METHOD_LABEL[m] ?? m}</span>
						<span class="block text-xs text-muted">
							{m === 'credential'
								? 'Your email address and a password'
								: 'Sign in with your Google account'}
						</span>
						{#snippet trail()}<Badge tone="success" dot>Connected</Badge>{/snippet}
					</SettingsRow>
				{/each}
			</ul>
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
				<PasswordStrength value={next} />
			{:else}
				<div class="text-sm text-muted">
					You sign in with Google, so there is no password to change here.
				</div>
			{/if}
		</Section>

		<Section
			id="sessions"
			icon={MonitorSmartphone}
			group="Security"
			title="Where you are signed in"
			text="End a session you do not recognise. It stops working at once."
		>
			<ul class="overflow-hidden rounded-lg border border-line" data-testid="session-list">
				{#each data.sessions as s (s.token)}
					{@const device = parseDevice(s.userAgent)}
					{@const DeviceIcon = DEVICE_ICON[device.kind]}
					<SettingsRow data-testid="session">
						{#snippet lead()}
							<span
								class="inline-flex size-8 items-center justify-center rounded-md border border-line bg-surface text-muted"
								aria-hidden="true"><DeviceIcon size={16} /></span
							>
						{/snippet}
						<span class="block truncate font-medium text-ink" title={s.userAgent || undefined}
							>{device.name}</span
						>
						<span class="block truncate text-xs text-muted"
							>{s.ipAddress || 'Unknown place'}, started {ago(s.createdAt)}</span
						>
						{#snippet trail()}
							{#if s.current}
								<Badge tone="success" dot>This device</Badge>
							{:else}
								<Button size="sm" variant="ghost" onclick={() => endSession(s.token)}>End it</Button
								>
							{/if}
						{/snippet}
					</SettingsRow>
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
			group="Security"
			title="Tools and tokens"
			text="The coding tools and tokens that act as you. Revoke one and it stops at once."
		>
			{#if data.tools.length === 0}
				<EmptyState
					kind="tools"
					title="No tool is connected"
					text="A coding tool you connect shows up here, and you can cut it off at any time."
				>
					{#snippet action()}<Button href="/connect">Connect a tool</Button>{/snippet}
				</EmptyState>
			{:else}
				<ul class="overflow-hidden rounded-lg border border-line" data-testid="tool-list">
					{#each data.tools as t (t.id)}
						{@const left = expiry(t.expiresAt)}
						<SettingsRow data-testid="tool">
							{#snippet lead()}<OrgTile
									name={t.orgName}
									logo={logoOf(t.org)}
									palette={paletteOf(t.org)}
								/>{/snippet}
							<span class="block truncate font-medium text-ink">{t.name}</span>
							<span class="block truncate text-xs text-muted"
								>{t.orgName}, <span class={cn(left.soon && 'text-warning')}>{left.text}</span></span
							>
							{#snippet trail()}
								<Badge>{t.kind}</Badge>
								<Button size="sm" variant="ghost" onclick={() => revokeTool(t.org, t.id)}
									>Revoke</Button
								>
							{/snippet}
						</SettingsRow>
					{/each}
				</ul>
				<div>
					<a class="text-sm text-accent-text hover:underline" href="/connect"
						>Connect another tool</a
					>
				</div>
			{/if}
		</Section>

		<!-- PREFERENCES -->
		<Section
			id="appearance"
			icon={Palette}
			group="Preferences"
			title="My appearance"
			text="Light or dark, only for you. It switches and saves as you pick, and the switch in the top bar does the same."
		>
			<!-- EACH CHOICE IS A SMALL DRAWING OF THE APP IN THAT MODE. THE CHECKED ONE FOLLOWS THE LIVE MODE, SO THE TOP BAR SWITCH MOVES IT TOO -->
			<div role="radiogroup" aria-label="Theme" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				{#each MODES as m (m.value)}
					{@const chosen = live.mode === m.value}
					<button
						type="button"
						role="radio"
						aria-checked={chosen}
						aria-label={m.label}
						tabindex={chosen ? 0 : -1}
						onclick={() => setLiveMode(m.value)}
						onkeydown={onModeKey}
						class={cn(
							'flex min-h-11 cursor-pointer flex-col gap-2 rounded-xl border p-2 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
							chosen ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-muted'
						)}
					>
						<ModePreview mode={m.value} />
						<span
							class={cn(
								'flex items-center justify-between px-1 text-sm font-medium',
								chosen ? 'text-accent-text' : 'text-ink'
							)}
						>
							{m.label}
							{#if chosen}<Check size={16} aria-hidden="true" />{/if}
						</span>
					</button>
				{/each}
			</div>
			<div class="text-xs text-muted">
				The accent colour comes from the organisation. An admin sets it in Organisation settings.
			</div>
		</Section>

		<Section
			id="continue"
			icon={Terminal}
			group="Preferences"
			title="Continue with"
			text="The tool the Continue button on an item starts with."
			dirty={dirty.continue}
			saving={st('continue').saving}
			saved={st('continue').saved}
			error={st('continue').error}
			onsave={() =>
				run('continue', 'continue', { continueTool, continueMode }, 'Continue setting saved.')}
		>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<SelectField
					label="Which tool do you usually work with?"
					options={CONTINUE_TOOL_OPTIONS}
					value={continueTool}
					onchange={(v) => {
						continueTool = parseTool(v);
						// A way the new tool cannot do becomes the next best one
						continueMode = effectiveMode(continueTool, continueMode);
					}}
				/>
				<SelectField
					label="How do you usually carry on?"
					options={continueWays}
					value={continueMode}
					onchange={(v) => (continueMode = parseMode(v))}
				/>
			</div>
			<div class="text-xs text-muted" data-testid="continue-example">{continueExample}</div>
		</Section>

		<Section
			id="checks"
			icon={ShieldCheck}
			group="Preferences"
			title="Browser checks"
			text="Where you want checks to run by default."
			dirty={dirty.checks}
			saving={st('checks').saving}
			saved={st('checks').saved}
			error={st('checks').error}
			onsave={() =>
				run('checks', 'prefs', prefsFields({ checkTarget: target }), 'Check setting saved.')}
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
			group="Preferences"
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
					}),
					'Email settings saved.'
				)}
		>
			<div class="divide-y divide-line rounded-lg border border-line px-3">
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
			</div>
		</Section>
	</SettingsShell>
</PageFrame>
