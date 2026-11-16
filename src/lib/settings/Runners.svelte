<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { listRunners } from '#lib/server/ops/environments.js';
	// IMPORTED MODULES
	import { ApiError, api } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import Section from '#lib/settings/Section.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Collapse from '#lib/ui/Collapse.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import Folders from '@lucide/svelte/icons/folders';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Server from '@lucide/svelte/icons/server';
	import Trash2 from '@lucide/svelte/icons/trash-2';

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
	let loaded = $state(false);
	let busy = $state('');
	let editing = $state<{ id: string; chosen: Record<string, boolean> } | null>(null);

	// -- REACTIVE STATES -- //

	const webApps = $derived(projects.filter((p) => p.webApp));
	const onlineCount = $derived(runners.filter((r) => r.online).length);

	// -- FUNCTIONS -- //

	async function load() {
		try {
			runners = await api<Runners>(org, '/runners');
		} catch {
			runners = [];
		}
		loaded = true;
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

	// The Projects button opens the panel under its own card and closes it again on a second press
	const toggleEdit = (r: Runners[number]) => (editing?.id === r.id ? (editing = null) : edit(r));

	// A closed panel shows what is saved; an open one shows what is being chosen
	const picked = (r: Runners[number], key: string) =>
		editing?.id === r.id ? !!editing.chosen[key] : r.projects.includes(key);
</script>

<Section
	id="runners"
	icon={Server}
	{group}
	title="Connected tools"
	text="The machines that answer browser checks and UI shots for this organisation, through the agent-flow-board bridge. Your agents connect the machine and keep it running; nothing to type here."
>
	{#if !loaded}
		<Skeleton lines={3} />
	{:else if runners.length === 0}
		<!-- NOTHING CONNECTED: THE ONLY ACTION IS THE CONNECT A TOOL PAGE -->
		<div class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
			<EmptyState
				kind="inbox"
				title="No tool is connected yet"
				text="Your agent connects it by itself the next time a check needs to run."
			>
				{#snippet action()}
					<Button variant="secondary" href={`/connect?org=${org}`}>Open Connect a tool</Button>
				{/snippet}
			</EmptyState>
		</div>
	{:else}
		<!-- THE SUMMARY LINE: HOW MANY TOOLS ARE ANSWERING RIGHT NOW -->
		<div
			class="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted tabular-nums"
			data-testid="runner-summary"
		>
			<span class={cn('inline-flex items-center gap-1.5', onlineCount > 0 && 'text-success')}>
				<span class="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true"></span>
				{onlineCount} online
			</span>
			<span aria-hidden="true">·</span>
			<span>{runners.length} {runners.length === 1 ? 'tool' : 'tools'}</span>
		</div>
		<ul class="stagger flex flex-col gap-2" data-testid="runner-list">
			{#each runners as r, i (r.id)}
				{@const open = editing?.id === r.id}
				{@const panel = `runner-projects-${r.id}`}
				<li
					class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
					style="--i:{i}"
					data-item
					data-testid="runner"
				>
					<div class="flex flex-wrap items-center gap-x-3 gap-y-2 p-3 max-sm:p-2.5">
						<!-- THE TILE CARRIES A LIVE DOT: IT PULSES SOFTLY WHEN THE TOOL IS ONLINE AND IS GREY WHEN IT IS NOT -->
						<span
							class="relative inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-raised text-muted"
							aria-hidden="true"
						>
							{#if r.kind !== 'tool' && r.kind !== 'local'}<Server size={20} />{:else}<Monitor
									size={20}
								/>{/if}
							<span
								class={cn(
									'absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-surface',
									r.online ? 'bg-success' : 'bg-muted'
								)}
							>
								{#if r.online}
									<span
										class="absolute inset-0 rounded-full bg-success opacity-60 motion-safe:animate-ping"
									></span>
								{/if}
							</span>
						</span>
						<div class="min-w-0 flex-1 basis-60">
							<p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
								<span class="min-w-0 font-medium [overflow-wrap:anywhere] text-ink">{r.name}</span>
								<Badge
									>{r.kind === 'tool'
										? 'afb-checks'
										: r.kind === 'local'
											? 'Local'
											: 'Hosted'}</Badge
								>
								<Badge tone={r.online ? 'success' : 'neutral'} dot={r.online}
									>{r.online ? 'Online' : 'Offline'}</Badge
								>
							</p>
							<p class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
								{#if r.projects.length}
									<span class="flex flex-wrap items-center gap-1.5">
										{#each r.projects as key (key)}
											<span
												class="rounded-md border border-line bg-raised px-1.5 py-px font-mono text-xs text-muted"
												>{key}</span
											>
										{/each}
									</span>
								{:else}
									<span>No project yet</span>
								{/if}
								{#if r.lastSeenAt}
									<span aria-hidden="true">·</span>
									<span>seen {ago(r.lastSeenAt)}</span>
								{/if}
							</p>
						</div>
						{#if can}
							<div class="flex items-center gap-2 max-sm:w-full">
								<Button
									size="sm"
									variant="ghost"
									class="max-sm:flex-1"
									aria-expanded={open}
									aria-controls={panel}
									onclick={() => toggleEdit(r)}><Folders size={14} />Projects</Button
								>
								<Button
									size="sm"
									variant="ghost"
									tone="danger"
									class="max-sm:flex-1"
									loading={busy === `remove-${r.id}`}
									onclick={() => remove(r.id)}><Trash2 size={14} />Remove</Button
								>
							</div>
						{/if}
					</div>
					{#if can}
						<!-- THE PROJECTS PANEL STAYS MOUNTED UNDER ITS CARD AND FOLDS OPEN AND SHUT -->
						<Collapse {open} id={panel}>
							<div
								class="flex flex-col gap-2 rounded-b-xl border-t border-line bg-raised/30 p-3 max-sm:p-2.5"
							>
								<p class="text-xs text-muted">Web apps this tool may check</p>
								<div class="grid gap-2 sm:grid-cols-2">
									{#each webApps as p (p.key)}
										{@const on = picked(r, p.key)}
										<label
											class={cn(
												'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors motion-reduce:transition-none',
												on
													? 'border-accent bg-accent-soft/60'
													: 'border-line bg-surface hover:bg-raised/60'
											)}
										>
											<span class="relative inline-flex size-5 shrink-0">
												<input
													type="checkbox"
													checked={on}
													aria-label={`${p.key} ${p.name}`}
													onchange={(e) => {
														if (editing?.id === r.id)
															editing.chosen[p.key] = e.currentTarget.checked;
													}}
													class="peer absolute inset-0 size-5 cursor-pointer appearance-none rounded-[5px] border-[1.5px] border-muted bg-surface checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
												/>
												<Check
													size={14}
													strokeWidth={3}
													class="pointer-events-none absolute top-[3px] left-[3px] text-accent-ink opacity-0 peer-checked:opacity-100"
												/>
											</span>
											<span class="font-mono text-xs text-muted">{p.key}</span>
											<span class="min-w-0 flex-1 truncate text-ink">{p.name}</span>
										</label>
									{/each}
								</div>
								<div class="flex flex-wrap gap-2 pt-1">
									<Button
										variant="primary"
										class="max-sm:flex-1"
										loading={busy === `projects-${r.id}`}
										onclick={saveProjects}>Save projects</Button
									>
									<Button variant="ghost" class="max-sm:flex-1" onclick={() => (editing = null)}
										>Cancel</Button
									>
								</div>
							</div>
						</Collapse>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</Section>
