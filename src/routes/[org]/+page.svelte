<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	import type { SubmitFunction } from '$app/forms';
	// -- ENVS -- //
	import { enhance } from '$app/forms';
	// -- MODULES -- //
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import ProjectTile from '#lib/board/ProjectTile.svelte';
	import { STATUSES } from '#lib/board/status.js';
	import {
		PROJECT_SORTS,
		PROJECT_VIEWS,
		TOOLBAR_FROM,
		activityText,
		arrangeProjects,
		parseSort,
		parseView,
		type ProjectSort,
		type ProjectView
	} from '#lib/board/projects.js';
	import { ROLE_LABEL } from '#lib/shared/roles.js';
	import NewProjectDialog from '#lib/board/NewProjectDialog.svelte';
	import { cn } from '#lib/ui/cn.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Select from '#lib/ui/Select.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
	import Pin from '@lucide/svelte/icons/pin';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- CONSTANTS -- //

	// One colour for each status in the stacked bar of a project card. Tokens only
	const SEGMENT: Record<string, string> = {
		PLANNED: 'bg-line',
		'IN PROGRESS': 'bg-info',
		'IN REVIEW': 'bg-warning',
		'ON HOLD': 'bg-hold',
		COMPLETED: 'bg-success'
	};

	// -- STATES -- //

	let creating = $state(false);
	let q = $state('');
	let sort = $state<ProjectSort>('name');
	let view = $state<ProjectView>('cards');
	/** What the person just pinned or unpinned, shown at once while the server confirms it. */
	let optimistic = $state<Record<string, boolean>>({});
	/** How many pin requests are still running for each project, so a quick second click does not clear the first one's state. */
	const pending: Record<string, number> = {};
	/** True once the remembered view and sort were read, so the first paint never overwrites them. */
	let restored = $state(false);

	// -- REACTIVE STATES -- //

	// Owners and admins create projects, in a dialog on this page
	const canCreate = $derived(data.org.role === 'owner' || data.org.role === 'admin');
	const rows = $derived(
		data.overview.map((o) => ({ ...o, pinned: optimistic[o.project.id] ?? o.pinned }))
	);
	// The toolbar only appears when there are enough projects to need it. Without it, search and filters stay off
	const hasToolbar = $derived(rows.length >= TOOLBAR_FROM);
	const groups = $derived(
		arrangeProjects(
			rows,
			hasToolbar ? { q, chip: 'all', sort } : { q: '', chip: 'all', sort: 'name' }
		)
	);
	// A remembered List view only applies while the toolbar that switches it is visible
	const shownView = $derived<ProjectView>(hasToolbar ? view : 'cards');
	const shownCount = $derived(groups.pinned.length + groups.rest.length);
	const narrowed = $derived(hasToolbar && q.trim() !== '');

	// -- REACTIVE STATEMENTS -- //

	// Remembers the view and the sort for this person and org. Reads happen in onMount, so the server and first paint agree
	$effect(() => {
		const saved = JSON.stringify({ view, sort });
		const slug = data.org.slug;
		if (!restored) return;
		untrack(() => {
			try {
				localStorage.setItem(`afb-orgview:${slug}`, saved);
			} catch {
				/* Storage can be blocked, the page works the same without it */
			}
		});
	});

	// -- FUNCTIONS -- //

	function clearFilters() {
		q = '';
	}

	/** Shows the new pin at once, and puts it back with a message when the server says no. */
	const enhancePin: SubmitFunction = ({ formData }) => {
		const id = String(formData.get('projectId'));
		const next = formData.get('intent') === 'pin';
		optimistic[id] = next;
		pending[id] = (pending[id] ?? 0) + 1;
		return async ({ result, update }) => {
			if (result.type === 'success') await update({ reset: false });
			else {
				toast.error(
					result.type === 'failure' && typeof result.data?.message === 'string'
						? result.data.message
						: 'Could not change the pin. Try again.'
				);
			}
			pending[id] -= 1;
			if (pending[id] <= 0) delete optimistic[id];
		};
	};

	// -- LIFECYCLES -- //

	// Remember the shape of this page, so the loading placeholder draws the same one next time
	onMount(() => {
		try {
			localStorage.setItem(`afb-org:${data.org.slug}`, data.overview.length ? 'cards' : 'empty');
			const saved = JSON.parse(localStorage.getItem(`afb-orgview:${data.org.slug}`) ?? '{}');
			sort = parseSort(saved.sort);
			view = parseView(saved.view);
		} catch {
			/* Storage can be blocked, the placeholder falls back to project cards */
		}
		restored = true;
	});
</script>

<svelte:head><title>{data.org.name}</title></svelte:head>

<PageFrame class="flex flex-col gap-6 pb-12">
	<PageHeader
		class="mb-0!"
		title="Projects"
		context={`Where your team and your agents keep their plans. You are ${ROLE_LABEL[data.org.role]} here.`}
	>
		{#snippet actions()}
			{#if canCreate}
				<Button variant="primary" onclick={() => (creating = true)} data-testid="new-project">
					<Plus size={16} /> New project
				</Button>
			{/if}
		{/snippet}
	</PageHeader>

	{#if data.overview.length === 0}
		<!-- NO PROJECTS YET -->
		<Card class="flex items-center justify-center">
			<EmptyState
				kind="projects"
				title={canCreate ? 'Create your first project' : 'No projects yet'}
				text={canCreate
					? 'A project keeps the plans from your tools and your team in one place.'
					: 'An admin creates the first project. Once it exists, plans from your tools and your team show up here.'}
			>
				{#snippet action()}
					{#if canCreate}
						<Button variant="primary" onclick={() => (creating = true)}>
							<Plus size={16} /> New project
						</Button>
					{/if}
				{/snippet}
			</EmptyState>
		</Card>
	{:else}
		<!-- ONE TOOLBAR CARD, THE SAME LOOK AS THE PROJECT PAGE: SEARCH, SORT, THE VIEW SWITCH, THEN THE QUICK FILTERS -->
		{#if hasToolbar}
			<div
				class="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-2.5"
				data-testid="projects-toolbar"
			>
				<div class="min-w-56 flex-1 sm:max-w-80">
					<TextField
						label="Find a project"
						icon={Search}
						hideLabel
						placeholder="Find a project by name or key"
						type="search"
						bind:value={q}
						data-testid="projects-search"
					/>
				</div>
				<Select
					label="Sort projects"
					icon={ArrowUpDown}
					prefix="Sort"
					options={PROJECT_SORTS}
					bind:value={sort}
					triggerClass="w-52"
					class="max-sm:flex-1"
				/>
				<span class="ml-auto">
					<SegmentedControl
						label="How to show the projects"
						value={view}
						options={PROJECT_VIEWS}
						onchange={(v) => (view = parseView(v))}
					/>
				</span>
			</div>
		{/if}

		{#if shownCount === 0}
			<!-- NOTHING MATCHES THE SEARCH OR THE QUICK FILTER. SAYS WHAT WAS ASKED AND HOW TO GET BACK -->
			<Card class="flex flex-col items-center gap-3 py-8 text-center" data-testid="projects-none">
				<p class="font-medium text-ink">
					{q.trim() ? `No project matches "${q.trim()}".` : 'No project to show.'}
				</p>
				<Button variant="secondary" onclick={clearFilters}>Show all projects</Button>
			</Card>
		{:else}
			{#if groups.pinned.length}
				<section class="flex flex-col gap-3" aria-label="Pinned projects">
					{#if rows.length > 1}
						<h2 class="flex items-center gap-2 text-xs font-medium text-muted">
							<Pin size={16} aria-hidden="true" /> Pinned
						</h2>
					{/if}
					{@render projectList(groups.pinned, 'pinned')}
				</section>
			{/if}
			{#if groups.rest.length}
				<section class="flex flex-col gap-3" aria-label="All projects">
					{#if groups.pinned.length}
						<h2 class="text-xs font-medium text-muted">
							{narrowed ? 'Other matches' : 'All projects'}
						</h2>
					{/if}
					{@render projectList(groups.rest, 'rest')}
				</section>
			{/if}
		{/if}
	{/if}
</PageFrame>

<NewProjectDialog
	org={data.org.slug}
	open={creating}
	onclose={() => (creating = false)}
	oncreated={(key) => goto(`/${data.org.slug}/${key}`)}
/>

<!-- THE PIN. A SIBLING OF THE CARD LINK, NEVER INSIDE IT, SO A CLICK PINS AND DOES NOT OPEN THE PROJECT -->
{#snippet pinButton(o: (typeof rows)[number])}
	<form method="POST" action="?/pin" use:enhance={enhancePin} class="absolute top-2 right-2 z-10">
		<input type="hidden" name="projectId" value={o.project.id} />
		<input type="hidden" name="intent" value={o.pinned ? 'unpin' : 'pin'} />
		<button
			type="submit"
			aria-pressed={o.pinned}
			aria-label={`${o.pinned ? 'Unpin' : 'Pin'} ${o.project.name}`}
			title={o.pinned ? 'Unpin' : 'Pin to the top'}
			class={cn(
				'inline-flex size-11 cursor-pointer items-center justify-center rounded-lg hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
				o.pinned ? 'text-accent' : 'text-muted hover:text-ink'
			)}
			data-testid="pin-project"
		>
			<Pin size={20} class={o.pinned ? 'fill-current' : ''} aria-hidden="true" />
		</button>
	</form>
{/snippet}

{#snippet projectList(list: typeof rows, group: string)}
	{#if shownView === 'cards'}
		<ul
			class="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
			data-testid={group === 'pinned' ? 'pinned-cards' : 'project-cards'}
		>
			{#each list as o, i (o.project.id)}
				<!-- THE STAGGER INDEX IS A RUNTIME VALUE FOR THE ENTRANCE MOTION -->
				<li class="relative" style="--i:{i}">
					<a
						href={`/${data.org.slug}/${o.project.key}`}
						class="lift flex h-full min-h-11 flex-col gap-3 rounded-xl border border-line bg-surface p-4 pr-14 shadow-[var(--elev-1)] after:absolute after:inset-0 after:rounded-xl hover:bg-raised"
						data-card
					>
						<span class="flex items-center gap-2">
							<ProjectTile
								id={o.project.id}
								projectKey={o.project.key}
								logoV={o.project.logoV}
								size={24}
							/>
							<span class="font-mono text-xs text-muted">{o.project.key}</span>
							{#if o.running > 0}<Badge tone="running">{o.running} running</Badge>{/if}
						</span>
						<span class="text-base leading-6 font-semibold">{o.project.name}</span>
						<span
							class="flex h-2 w-full overflow-hidden rounded-full bg-raised"
							role="img"
							aria-label={`${o.total} items by status`}
						>
							{#each STATUSES.filter((x) => (o.byStatus[x] ?? 0) > 0 && x !== 'REMOVED') as x (x)}
								<!-- SEGMENT WIDTH IS A RUNTIME PERCENT OF THE PROJECT ITEMS -->
								<span class={SEGMENT[x]} style="width:{((o.byStatus[x] ?? 0) / o.total) * 100}%"
								></span>
							{/each}
						</span>
						<span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
							<span class="font-medium text-ink">{o.total} {o.total === 1 ? 'item' : 'items'}</span>
							{#each STATUSES.filter((x) => (o.byStatus[x] ?? 0) > 0 && x !== 'REMOVED' && x !== 'COMPLETED' && x !== 'PLANNED') as x (x)}
								<span>{o.byStatus[x]} {x.toLowerCase()}</span>
							{/each}
						</span>
						<span class="text-xs text-muted">{activityText(o.lastActivityAt)}</span>
					</a>
					{@render pinButton(o)}
				</li>
			{/each}
		</ul>
	{:else}
		<Card padded={false}>
			<ul data-testid="project-list">
				{#each list as o (o.project.id)}
					<li
						class="relative flex min-h-14 flex-col justify-center gap-1 border-b border-line py-2 pr-14 pl-4 last:border-b-0 hover:bg-raised sm:flex-row sm:items-center sm:gap-4"
						data-row
					>
						<a
							href={`/${data.org.slug}/${o.project.key}`}
							class="flex min-w-0 flex-1 items-center gap-2 after:absolute after:inset-0"
						>
							<ProjectTile
								id={o.project.id}
								projectKey={o.project.key}
								logoV={o.project.logoV}
								size={24}
							/>
							<span class="font-mono text-xs text-muted">{o.project.key}</span>
							<span class="truncate font-medium text-ink">{o.project.name}</span>
							{#if o.running > 0}<Badge tone="running">{o.running} running</Badge>{/if}
						</a>
						<span
							class="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-muted tabular-nums"
						>
							<span class="text-ink">{o.total} {o.total === 1 ? 'item' : 'items'}</span>
							<span>{o.byStatus['IN PROGRESS'] ?? 0} in progress</span>
							<span>{activityText(o.lastActivityAt)}</span>
						</span>
						{@render pinButton(o)}
					</li>
				{/each}
			</ul>
		</Card>
	{/if}
{/snippet}
