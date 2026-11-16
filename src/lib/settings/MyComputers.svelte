<script lang="ts">
	// IMPORTED TYPES
	import type { MyBridge, MyBridges } from '#lib/server/ops/bridgeRunners.js';
	import type { OrgPalette } from '#lib/server/db/schema/core.js';
	// IMPORTED ENVS
	import { invalidateAll } from '$app/navigation';
	// IMPORTED MODULES
	import { ApiError, api } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Collapse from '#lib/ui/Collapse.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import OrgTile from '#lib/board/OrgTile.svelte';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import Folders from '@lucide/svelte/icons/folders';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	// -- TYPES -- //

	type Computer = MyBridge & { org: string; orgName: string; webApps: MyBridges['webApps'] };

	// -- REQUIRED PROPS -- //

	let {
		computers,
		logoOf,
		paletteOf
	}: {
		/** The person's own computers, one entry per organisation each is registered in. */
		computers: Computer[];
		/** The logo and the accent of an organisation, so its tile shows its own colour. */
		logoOf: (slug: string) => string | null;
		paletteOf: (slug: string) => OrgPalette | null;
	} = $props();

	// -- STATES -- //

	let busy = $state('');
	let editing = $state<{ id: string; chosen: Record<string, boolean> } | null>(null);

	// -- FUNCTIONS -- //

	const edit = (c: Computer) =>
		(editing = { id: c.id, chosen: Object.fromEntries(c.projects.map((k) => [k, true])) });

	// The Projects button opens the panel under its own row and closes it again on a second press
	const toggleEdit = (c: Computer) => (editing?.id === c.id ? (editing = null) : edit(c));

	// A closed panel shows what is saved; an open one shows what is being chosen
	const picked = (c: Computer, key: string) =>
		editing?.id === c.id ? !!editing.chosen[key] : c.projects.includes(key);

	async function saveProjects(c: Computer) {
		if (editing?.id !== c.id) return;
		const keys = c.webApps.filter((p) => editing!.chosen[p.key]).map((p) => p.key);
		busy = `projects-${c.id}`;
		try {
			await toast.promise(
				api(c.org, `/my-bridges/${c.id}/projects`, { method: 'PUT', body: { projects: keys } }),
				{
					id: 'computer-projects',
					loading: 'Saving the web apps...',
					success: 'Web apps saved.',
					error: (e) => (e instanceof ApiError ? e.message : 'The web apps were not saved.')
				}
			);
			editing = null;
			await invalidateAll();
		} catch {
			// The promise toast already shows the failure
		} finally {
			busy = '';
		}
	}

	async function remove(c: Computer) {
		if (
			!(await askConfirm({
				title: `Remove this computer from ${c.orgName}?`,
				body: 'It stops taking your browser checks for this organisation at once, and a check it is running ends. Your other organisations are not touched. To use it again, your agent connects it again.',
				confirmLabel: 'Remove'
			}))
		)
			return;
		busy = `remove-${c.id}`;
		try {
			await toast.promise(api(c.org, `/my-bridges/${c.id}`, { method: 'DELETE' }), {
				id: 'computer-remove',
				loading: 'Removing...',
				success: 'Removed.',
				error: (e) => (e instanceof ApiError ? e.message : 'It was not removed.')
			});
			if (editing?.id === c.id) editing = null;
			await invalidateAll();
		} catch {
			// The promise toast already shows the failure
		} finally {
			busy = '';
		}
	}
</script>

<!-- THE COMPUTERS OF THIS PERSON THAT RUN THEIR BROWSER CHECKS: ONE ROW PER ORGANISATION A COMPUTER IS REGISTERED IN -->
{#if computers.length === 0}
	<p
		class="rounded-lg border border-line px-3 py-3 text-sm text-muted"
		data-testid="computers-empty"
	>
		No computer of yours runs browser checks yet. Your agent connects one by itself the next time a
		check needs to run.
		<a class="text-accent-text hover:underline" href="/connect">Open Connect a tool</a>
	</p>
{:else}
	<ul class="overflow-hidden rounded-lg border border-line" data-testid="computer-list">
		{#each computers as c (`${c.org}:${c.id}`)}
			{@const open = editing?.id === c.id}
			{@const panel = `computer-projects-${c.id}`}
			<li class="border-b border-line last:border-b-0" data-item data-testid="computer">
				<div class="flex min-h-12 flex-wrap items-center gap-3 px-3 py-2 max-sm:min-h-14">
					<!-- THE TILE CARRIES A LIVE DOT: GREEN WHEN THE COMPUTER IS ONLINE AND GREY WHEN IT IS NOT -->
					<span class="inline-flex shrink-0 items-center">
						<span
							class="relative inline-flex size-10 items-center justify-center rounded-lg border border-line bg-raised text-muted"
							aria-hidden="true"
						>
							<Monitor size={20} />
							<span
								class={cn(
									'absolute -right-1 -bottom-1 size-3 rounded-full border-2 border-surface',
									c.online ? 'bg-success' : 'bg-muted'
								)}
							></span>
						</span>
					</span>
					<div class="min-w-40 flex-1 text-sm">
						<p class="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span class="min-w-0 font-medium [overflow-wrap:anywhere] text-ink">{c.name}</span>
							<Badge tone={c.online ? 'success' : 'neutral'} icon={c.online}
								>{c.online ? 'Online' : 'Offline'}</Badge
							>
						</p>
						<p class="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
							<span class="inline-flex items-center gap-1.5">
								<OrgTile
									name={c.orgName}
									logo={logoOf(c.org)}
									palette={paletteOf(c.org)}
									size={20}
								/>
								{c.orgName}
							</span>
							<span aria-hidden="true">·</span>
							{#if c.projects.length}
								<span class="flex flex-wrap items-center gap-1.5">
									{#each c.projects as key (key)}
										<span
											class="rounded-md border border-line bg-raised px-1.5 py-px font-mono text-xs text-muted"
											>{key}</span
										>
									{/each}
								</span>
							{:else}
								<span>No web app yet</span>
							{/if}
							{#if c.lastSeenAt}
								<span aria-hidden="true">·</span>
								<span>seen {ago(c.lastSeenAt)}</span>
							{/if}
						</p>
					</div>
					<div class="flex shrink-0 flex-wrap items-center gap-2 max-sm:w-full">
						<Button
							size="sm"
							variant="ghost"
							class="max-sm:flex-1"
							aria-expanded={open}
							aria-controls={panel}
							onclick={() => toggleEdit(c)}><Folders size={14} />Web apps</Button
						>
						<Button
							size="sm"
							variant="ghost"
							tone="danger"
							class="max-sm:flex-1"
							loading={busy === `remove-${c.id}`}
							onclick={() => remove(c)}><Trash2 size={14} />Remove</Button
						>
					</div>
				</div>
				<!-- THE WEB APPS PANEL STAYS MOUNTED UNDER ITS ROW AND FOLDS OPEN AND SHUT -->
				<Collapse {open} id={panel}>
					<div class="flex flex-col gap-2 border-t border-line bg-raised/30 px-3 py-3">
						<p class="text-xs text-muted">Web apps this computer may check for {c.orgName}</p>
						{#if c.webApps.length === 0}
							<p class="text-sm text-muted">
								{c.orgName} has no web app yet. A project becomes one in its settings.
							</p>
						{:else}
							<div class="grid gap-2 sm:grid-cols-2">
								{#each c.webApps as p (p.key)}
									{@const on = picked(c, p.key)}
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
													if (editing?.id === c.id) editing.chosen[p.key] = e.currentTarget.checked;
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
									loading={busy === `projects-${c.id}`}
									onclick={() => saveProjects(c)}>Save web apps</Button
								>
								<Button variant="ghost" class="max-sm:flex-1" onclick={() => (editing = null)}
									>Cancel</Button
								>
							</div>
						{/if}
					</div>
				</Collapse>
			</li>
		{/each}
	</ul>
{/if}
