<script lang="ts">
	// -- DEP-TYPES -- //
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import type { listRunners } from '#lib/server/ops/environments.js';
	// -- MODULES -- //
	import { ApiError, api } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import Section from '#lib/settings/Section.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Checkbox from '#lib/ui/Checkbox.svelte';
	import Select from '#lib/ui/Select.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- TYPES -- //

	type Runners = Awaited<ReturnType<typeof listRunners>>;

	// -- REQUIRED PROPS -- //

	let {
		org,
		projects,
		can,
		baseUrl
	}: {
		org: string;
		projects: { key: string; name: string; webApp: boolean }[];
		can: boolean;
		baseUrl: string;
	} = $props();

	// -- STATES -- //

	let runners = $state<Runners>([]);
	let name = $state('');
	let kind = $state('local');
	let chosen = $state<Record<string, boolean>>({});
	let made = $state<{ token: string; name: string; kind: string } | null>(null);
	let error = $state('');
	let busy = $state('');
	let editing = $state<{ id: string; chosen: Record<string, boolean> } | null>(null);

	// -- REACTIVE STATES -- //

	const webApps = $derived(projects.filter((p) => p.webApp));
	const startLine = $derived(
		made
			? `node --import tsx packages/runner/src/cli.ts start --server ${baseUrl} --token ${made.token}${made.kind === 'hosted' ? ' --hosted' : ''}`
			: ''
	);

	// -- FUNCTIONS -- //

	async function load() {
		try {
			runners = await api<Runners>(org, '/runners');
		} catch {
			runners = [];
		}
	}

	$effect(() => {
		void org;
		void load();
	});

	async function create() {
		busy = 'create';
		error = '';
		try {
			const r = await api<{ token: string; name: string; kind: string }>(org, '/runners', {
				body: {
					name: name.trim(),
					kind,
					projects: webApps.filter((p) => chosen[p.key]).map((p) => p.key)
				}
			});
			made = r;
			name = '';
			chosen = {};
			await load();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'The runner was not made.';
		} finally {
			busy = '';
		}
	}

	async function saveProjects() {
		if (!editing) return;
		busy = `projects-${editing.id}`;
		error = '';
		try {
			await api(org, `/runners/${editing.id}/projects`, {
				method: 'PUT',
				body: { projects: webApps.filter((p) => editing!.chosen[p.key]).map((p) => p.key) }
			});
			editing = null;
			await load();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'The projects were not saved.';
		} finally {
			busy = '';
		}
	}

	async function remove(id: string) {
		if (
			!(await askConfirm({
				title: 'Remove this runner?',
				body: 'Its token stops working at once. Runs it holds are given back.',
				confirmLabel: 'Remove'
			}))
		)
			return;
		busy = `remove-${id}`;
		error = '';
		try {
			await api(org, `/runners/${id}`, { method: 'DELETE' });
			await load();
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'The runner was not removed.';
		} finally {
			busy = '';
		}
	}

	const edit = (r: Runners[number]) =>
		(editing = { id: r.id, chosen: Object.fromEntries(r.projects.map((k) => [k, true])) });
</script>

<Section
	id="runners"
	title="Runners"
	text="Programs that run browser checks and UI shots. A local runner works on a machine you own and asks you before it runs anything new. A hosted runner runs in a throwaway container."
>
	{#if runners.length === 0}
		<div class="text-sm text-muted">No runners yet.</div>
	{:else}
		<ul class="rounded-lg border border-line" data-testid="runner-list">
			{#each runners as r (r.id)}
				<li
					class="flex flex-col gap-2 border-b border-line px-3 py-2 last:border-b-0"
					data-item
					data-testid="runner"
				>
					<div class="flex flex-wrap items-center gap-2">
						<span class="text-sm font-medium">{r.name}</span>
						<Badge>{r.kind === 'local' ? 'Local' : 'Hosted'}</Badge>
						<Badge tone={r.online ? 'success' : 'neutral'}>{r.online ? 'Online' : 'Offline'}</Badge>
						<span class="min-w-0 flex-1 text-xs text-muted">
							{r.projects.length ? r.projects.join(', ') : 'No project yet'}{r.lastSeenAt
								? `, seen ${ago(r.lastSeenAt)}`
								: ''}
						</span>
						{#if can}
							<Button size="sm" variant="ghost" onclick={() => edit(r)}>Projects</Button>
							<Button
								size="sm"
								variant="ghost"
								loading={busy === `remove-${r.id}`}
								onclick={() => remove(r.id)}>Remove</Button
							>
						{/if}
					</div>
					{#if editing?.id === r.id}
						<div class="flex flex-col gap-1 rounded-lg border border-line p-3">
							{#each webApps as p (p.key)}
								<Checkbox
									label={`${p.key} ${p.name}`}
									checked={!!editing.chosen[p.key]}
									onchange={(e) => (editing!.chosen[p.key] = e.currentTarget.checked)}
								/>
							{/each}
							<div class="flex gap-2 pt-1">
								<Button
									variant="primary"
									loading={busy === `projects-${r.id}`}
									onclick={saveProjects}>Save projects</Button
								>
								<Button variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
							</div>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if error}<p role="alert" class="text-sm text-danger" data-testid="runner-error">{error}</p>{/if}

	{#if can}
		{#if made}
			<div
				class="flex flex-col gap-2 rounded-lg border border-line bg-raised p-3"
				data-testid="runner-token-box"
			>
				<p class="text-sm font-medium">
					Copy this now. The token is shown once and cannot be read again.
				</p>
				<code class="block text-xs break-all" data-testid="runner-token">{made.token}</code>
				<p class="text-xs text-muted">
					Start it on the machine that will run the checks, from the project folder:
				</p>
				<code class="block text-xs break-all">{startLine}</code>
				<div><Button size="sm" onclick={() => (made = null)}>I have copied it</Button></div>
			</div>
		{/if}
		<form
			class="flex flex-col gap-3 rounded-lg border border-line p-3"
			onsubmit={(e) => {
				e.preventDefault();
				void create();
			}}
		>
			<div class="flex flex-wrap items-end gap-2">
				<TextField
					label="Name"
					bind:value={name}
					placeholder="Laptop"
					class="w-56"
					data-testid="runner-name"
				/>
				<Select
					label="Kind"
					options={[
						{ value: 'local', label: 'Local' },
						{ value: 'hosted', label: 'Hosted' }
					]}
					bind:value={kind}
					class="w-40"
				/>
			</div>
			{#if webApps.length}
				<div class="flex flex-col">
					<span class="text-xs font-medium text-muted">Projects it serves</span>
					{#each webApps as p (p.key)}
						<Checkbox
							label={`${p.key} ${p.name}`}
							checked={!!chosen[p.key]}
							onchange={(e) => (chosen[p.key] = e.currentTarget.checked)}
						/>
					{/each}
				</div>
			{:else}
				<p class="text-xs text-muted">
					No project is a web app yet. Turn that on in a project's settings first.
				</p>
			{/if}
			<div>
				<Button
					type="submit"
					variant="primary"
					loading={busy === 'create'}
					disabled={name.trim().length < 2}
					data-testid="runner-create">Register runner</Button
				>
			</div>
		</form>
	{/if}
</Section>
