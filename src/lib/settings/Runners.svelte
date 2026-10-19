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
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Server from '@lucide/svelte/icons/server';

	// -- TYPES -- //

	type Runners = Awaited<ReturnType<typeof listRunners>>;

	// -- REQUIRED PROPS -- //

	let {
		org,
		projects,
		can,
		group
	}: {
		org: string;
		projects: { key: string; name: string; webApp: boolean }[];
		can: boolean;
		/** The heading its tab sits under in the settings navigation. */
		group?: string;
	} = $props();

	// -- STATES -- //

	let runners = $state<Runners>([]);
	let busy = $state('');
	let editing = $state<{ id: string; chosen: Record<string, boolean> } | null>(null);

	// -- REACTIVE STATES -- //

	const webApps = $derived(projects.filter((p) => p.webApp));

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

	async function saveProjects() {
		if (!editing) return;
		busy = `projects-${editing.id}`;
		try {
			await toast.promise(
				api(org, `/runners/${editing.id}/projects`, {
					method: 'PUT',
					body: { projects: webApps.filter((p) => editing!.chosen[p.key]).map((p) => p.key) }
				}),
				{
					id: 'runner-projects',
					loading: 'Saving the projects...',
					success: 'Projects saved.',
					error: (e) => (e instanceof ApiError ? e.message : 'The projects were not saved.')
				}
			);
			editing = null;
			await load();
		} catch {
			// The promise toast already shows the failure
		} finally {
			busy = '';
		}
	}

	async function remove(id: string) {
		if (
			!(await askConfirm({
				title: 'Remove this tool?',
				body: 'Its token stops working at once. Runs it holds are given back. To connect it again, run connect in its folder.',
				confirmLabel: 'Remove'
			}))
		)
			return;
		busy = `remove-${id}`;
		try {
			await toast.promise(api(org, `/runners/${id}`, { method: 'DELETE' }), {
				id: 'runner-remove',
				loading: 'Removing...',
				success: 'Removed.',
				error: (e) => (e instanceof ApiError ? e.message : 'It was not removed.')
			});
			await load();
		} catch {
			// The promise toast already shows the failure
		} finally {
			busy = '';
		}
	}

	const edit = (r: Runners[number]) =>
		(editing = { id: r.id, chosen: Object.fromEntries(r.projects.map((k) => [k, true])) });
</script>

<Section
	id="runners"
	icon={Server}
	{group}
	title="Connected tools"
	text="The afb-checks tools that answer browser checks and UI shots for this organisation. A tool connects itself from its own folder, with node afb-checks.mjs connect."
>
	{#if runners.length === 0}
		<div class="text-sm text-muted">
			No tool is connected yet. In the afb-checks folder run
			<span class="font-mono text-xs break-all">node afb-checks.mjs connect</span>.
		</div>
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
						<Badge
							>{r.kind === 'tool' ? 'afb-checks' : r.kind === 'local' ? 'Local' : 'Hosted'}</Badge
						>
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
								tone="danger"
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
</Section>
