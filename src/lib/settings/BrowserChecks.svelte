<script lang="ts">
	// -- DEP-TYPES -- //
	import type { listAccounts, listEnvironments } from '#lib/server/ops/environments.js';
	import type { getScale } from '#lib/server/ops/uiShots.js';
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import Section from '#lib/settings/Section.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Select from '#lib/ui/Select.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Globe from '@lucide/svelte/icons/globe';
	import MonitorCheck from '@lucide/svelte/icons/monitor-check';
	import Ruler from '@lucide/svelte/icons/ruler';
	import Users from '@lucide/svelte/icons/users';

	// -- TYPES -- //

	type Envs = Awaited<ReturnType<typeof listEnvironments>>;
	type Accounts = Awaited<ReturnType<typeof listAccounts>>;
	type Scale = Awaited<ReturnType<typeof getScale>>;

	// -- REQUIRED PROPS -- //

	let {
		org,
		projectKey,
		webApp,
		defaultTarget,
		can
	}: { org: string; projectKey: string; webApp: boolean; defaultTarget: string; can: boolean } =
		$props();

	// -- CONSTANTS -- //

	const TARGETS = [
		{
			value: 'preview',
			label: 'Build preview',
			hint: 'Built from your working tree. The usual choice.'
		},
		{ value: 'deployed', label: 'Deployed site' },
		{ value: 'dev', label: 'Dev server', hint: 'Slow. Pick it by hand only.' }
	];
	const KINDS = [
		{ value: 'preview', label: 'Build preview' },
		{ value: 'dev', label: 'Dev server' },
		{ value: 'deployed', label: 'Deployed site' }
	];

	// -- STATES -- //

	let target = $derived(defaultTarget);
	let envs = $state<Envs>([]);
	let accounts = $state<Accounts>([]);
	let scale = $state<Scale | null>(null);
	let status = $state<Record<string, { saving: boolean; saved: boolean; error: string }>>({});
	let envName = $state('');
	let envKind = $state('preview');
	let envUrl = $state('');
	let envVersion = $state('');
	let envProduction = $state(false);
	let envWrites = $state(false);
	let accName = $state('default');
	let accEmail = $state('');
	let accPassword = $state('');
	let measuring = $state(false);
	let measureNote = $state('');

	// -- REACTIVE STATES -- //

	const base = $derived(`/projects/${projectKey}`);
	const st = (id: string) => status[id] ?? { saving: false, saved: false, error: '' };

	// -- FUNCTIONS -- //

	async function load() {
		if (!webApp) return;
		try {
			[envs, accounts, scale] = await Promise.all([
				api<Envs>(org, `${base}/environments`),
				api<Accounts>(org, `${base}/accounts`).catch(() => [] as Accounts),
				api<Scale>(org, `${base}/scale`)
			]);
		} catch {
			/* A reader without access sees empty lists */
		}
	}

	$effect(() => {
		void projectKey;
		void webApp;
		void load();
	});

	async function act(id: string, run: () => Promise<unknown>, ok: string, after?: () => void) {
		status[id] = { saving: true, saved: false, error: '' };
		try {
			// The toast wraps the raw write, so a refusal rejects it and no success toast shows
			await toast.promise(run(), {
				id: `checks-${id}`,
				loading: 'Saving...',
				success: ok,
				error: (e) => (e instanceof ApiError ? e.message : 'That was not saved.')
			});
			after?.();
			await load();
			status[id] = { saving: false, saved: true, error: '' };
		} catch (e) {
			status[id] = {
				saving: false,
				saved: false,
				error: e instanceof ApiError ? e.message : 'That was not saved.'
			};
		}
	}

	const saveTarget = () =>
		act(
			'checks-target',
			async () => {
				await api(org, base, { method: 'PATCH', body: { defaultTarget: target }, key: newKey() });
				await invalidate('afb:settings');
			},
			'Default target saved.'
		);

	const saveEnv = () =>
		act(
			'environments',
			() =>
				api(org, `${base}/environments`, {
					method: 'PUT',
					body: {
						name: envName.trim(),
						kind: envKind,
						url: envUrl.trim(),
						production: envProduction,
						writeAllowed: envWrites,
						versionPath: envVersion.trim() || null
					}
				}),
			'Environment saved.',
			() => {
				envName = '';
				envUrl = '';
				envVersion = '';
				envProduction = false;
				envWrites = false;
			}
		);

	const removeEnv = async (name: string) => {
		if (
			!(await askConfirm({
				title: `Remove the environment ${name}?`,
				body: 'Checks can no longer run against it.',
				confirmLabel: 'Remove'
			}))
		)
			return;
		await act(
			'environments',
			() => api(org, `${base}/environments/${encodeURIComponent(name)}`, { method: 'DELETE' }),
			'Environment removed.'
		);
	};

	const saveAccount = () =>
		act(
			'accounts',
			() =>
				api(org, `${base}/accounts`, {
					method: 'PUT',
					body: { name: accName.trim(), email: accEmail.trim(), password: accPassword }
				}),
			'Test account saved.',
			() => {
				accEmail = '';
				accPassword = '';
			}
		);

	const removeAccount = async (name: string) => {
		if (
			!(await askConfirm({
				title: `Remove the test account ${name}?`,
				body: 'Its sealed password is deleted. Checks that sign in with it stop working until it is added again.',
				confirmLabel: 'Remove'
			}))
		)
			return;
		await act(
			'accounts',
			() => api(org, `${base}/accounts/${encodeURIComponent(name)}`, { method: 'DELETE' }),
			'Test account removed.'
		);
	};

	async function measure() {
		measuring = true;
		measureNote = '';
		try {
			const r = await toast.promise(
				api<{ unavailable: boolean; reason: string | null }>(org, `${base}/scale/measure`, {
					body: {}
				}),
				{
					loading: 'Asking for a measure...',
					success: (r) => (r.unavailable ? 'That target is not available.' : 'Measure requested.'),
					error: (e) => (e instanceof ApiError ? e.message : 'The measure was not asked for.')
				}
			);
			measureNote = r.unavailable
				? (r.reason ?? 'That target is not available.')
				: 'Asked. A runner will open the reference pages and the scale appears here when it is done.';
			if (!r.unavailable) {
				const before = scale?.scales.map((s) => String(s.updatedAt)).join() ?? '';
				for (let i = 0; i < 40; i++) {
					await new Promise((res) => setTimeout(res, 3000));
					await load();
					if ((scale?.scales.map((s) => String(s.updatedAt)).join() ?? '') !== before) {
						measureNote = 'The scale was measured.';
						break;
					}
				}
			}
		} catch {
			// The promise toast already shows the failure
		} finally {
			measuring = false;
		}
	}
</script>

{#if !webApp}
	<div
		class="rounded-xl border border-line bg-surface p-4 text-sm text-muted shadow-[var(--elev-1)]"
		data-testid="not-web-app"
	>
		Browser checks and UI shots are for web apps. Turn on "This project is a web app" in General
		first.
	</div>
{:else}
	<Section
		id="checks-target"
		icon={MonitorCheck}
		title="Browser checks"
		text="Where a check runs when nobody picks a target. The build preview never waits for a push or a deploy."
		dirty={target !== defaultTarget}
		saving={st('checks-target').saving}
		saved={st('checks-target').saved}
		error={st('checks-target').error}
		readonly={!can}
		onsave={saveTarget}
	>
		<Select
			label="Default target"
			options={TARGETS}
			bind:value={target}
			disabled={!can}
			class="w-56"
		/>
	</Section>

	<Section
		id="environments"
		icon={Globe}
		title="Environments"
		text="The addresses checks and UI shots open. A production site is read only unless you allow writes on purpose."
	>
		{#if envs.length === 0}
			<div class="text-sm text-muted">No environments yet.</div>
		{:else}
			<ul class="rounded-lg border border-line" data-testid="environments">
				{#each envs as e (e.id)}
					<li
						class="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 last:border-b-0"
						data-item
						data-testid="environment"
					>
						<span class="text-sm font-medium">{e.name}</span>
						<Badge>{KINDS.find((k) => k.value === e.kind)?.label}</Badge>
						{#if e.production}<Badge tone="warning">Production</Badge>{/if}
						{#if e.writeAllowed}<Badge tone="danger">Writes allowed</Badge>{/if}
						<span class="min-w-0 flex-1 truncate text-xs text-muted">{e.url}</span>
						{#if can}<Button size="sm" variant="ghost" onclick={() => removeEnv(e.name)}
								>Remove</Button
							>{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if can}
			<div class="flex flex-col gap-3 rounded-lg border border-line p-3">
				<div class="flex flex-wrap items-end gap-2">
					<TextField label="Name" bind:value={envName} class="w-40" data-testid="env-name" />
					<Select label="Kind" options={KINDS} bind:value={envKind} class="w-48" />
					<TextField
						label="Address"
						bind:value={envUrl}
						placeholder="https://"
						class="min-w-56 flex-1"
						data-testid="env-url"
					/>
				</div>
				<TextField
					label="Version path (optional)"
					bind:value={envVersion}
					placeholder="/version"
					hint="Where the site says which commit it runs, so a run can wait until it is live."
					class="w-72"
				/>
				<Switch
					label="This is production"
					hint="Only a deployed site can be."
					bind:checked={envProduction}
					disabled={envKind !== 'deployed'}
				/>
				<Switch
					label="Allow writes"
					hint="Off keeps every run read only. Turn it on only for a site made for testing."
					bind:checked={envWrites}
				/>
				<div class="flex items-center gap-3">
					<Button
						variant="primary"
						loading={st('environments').saving}
						disabled={!envName.trim() || !envUrl.trim()}
						onclick={saveEnv}
						data-testid="save-environment">Save environment</Button
					>
					{#if st('environments').error}<span class="text-sm text-danger" role="alert"
							>{st('environments').error}</span
						>{/if}
				</div>
			</div>
		{/if}
	</Section>

	<Section
		id="accounts"
		icon={Users}
		title="Test accounts"
		text="People a run signs in as. The runner signs in for the script, which never sees the password. A saved password cannot be read back."
	>
		{#if accounts.length === 0}
			<div class="text-sm text-muted">No test accounts yet.</div>
		{:else}
			<ul class="rounded-lg border border-line" data-testid="accounts">
				{#each accounts as a (a.name)}
					<li
						class="flex items-center gap-2 border-b border-line px-3 py-2 last:border-b-0"
						data-item
						data-testid="account"
					>
						<span class="min-w-0 flex-1 text-sm font-medium">{a.name}</span>
						{#if can}<Button size="sm" variant="ghost" onclick={() => removeAccount(a.name)}
								>Remove</Button
							>{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if can}
			<div class="flex flex-col gap-3 rounded-lg border border-line p-3">
				<!-- THREE FIELDS ON ONE GRID, SO THE LABELS AND THE FIELDS SHARE ONE TOP EDGE -->
				<div class="grid items-start gap-3 sm:grid-cols-[11rem_1fr_1fr]">
					<TextField label="Name" bind:value={accName} data-testid="account-name" />
					<TextField label="Email" type="email" bind:value={accEmail} data-testid="account-email" />
					<TextField
						label="Password"
						type="password"
						autocomplete="new-password"
						bind:value={accPassword}
						data-testid="account-password"
					/>
				</div>
				<p class="text-xs text-muted">
					The account named default is used when a page names no account. A password needs at least
					8 characters.
				</p>
				<div class="flex items-center gap-3">
					<Button
						variant="primary"
						loading={st('accounts').saving}
						disabled={!accName.trim() || !accEmail.trim() || accPassword.length < 8}
						onclick={saveAccount}
						data-testid="save-account">Save test account</Button
					>
					{#if st('accounts').error}<span class="text-sm text-danger" role="alert"
							>{st('accounts').error}</span
						>{/if}
				</div>
			</div>
		{/if}
	</Section>

	<Section
		id="scale"
		icon={Ruler}
		title="Design scale"
		text="The sizes your reference pages really use. UI shots flag a screen that steps off them. A level seen on fewer than 3 pages is left out."
	>
		{#if scale && scale.scales.length}
			<ul class="rounded-lg border border-line" data-testid="scales">
				{#each scale.scales as s (s.theme + s.viewport)}
					<li
						class="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-sm last:border-b-0"
						data-item
					>
						<span class="font-medium">{s.theme}, {s.viewport === 1440 ? 'desktop' : 'phone'}</span>
						<span class="text-xs text-muted"
							>{Object.keys(s.levels).length} levels, {Object.keys(s.seenOn).length -
								Object.keys(s.levels).length} left out</span
						>
					</li>
				{/each}
			</ul>
		{:else}
			<div class="text-sm text-muted">
				Not measured yet. Name 3 to 15 reference pages in UI shots below, then measure.
			</div>
		{/if}
		{#if can}
			<div class="flex flex-wrap items-center gap-3">
				<Button loading={measuring} onclick={measure} data-testid="measure-scale"
					>Measure now</Button
				>
				{#if measureNote}<span class="text-sm text-muted" role="status">{measureNote}</span>{/if}
			</div>
		{/if}
	</Section>
{/if}
