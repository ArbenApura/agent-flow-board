<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- ENVS -- //
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import EventList from '#lib/board/EventList.svelte';
	import PlanTab from '#lib/board/item/PlanTab.svelte';
	import { DRIFT_TEXT, STATUSES, STATUS_TONE, type Status } from '#lib/board/status.js';
	import ActionMenu from '#lib/ui/ActionMenu.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import Progress from '#lib/ui/Progress.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import RunningBadge from '#lib/ui/RunningBadge.svelte';
	import Select from '#lib/ui/Select.svelte';
	import StaleWriteDialog from '#lib/ui/StaleWriteDialog.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Lock from 'phosphor-svelte/lib/Lock';
	import PencilSimple from 'phosphor-svelte/lib/PencilSimple';
	import Trash from 'phosphor-svelte/lib/Trash';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- CONSTANTS -- //

	const TABS = [
		'plan',
		'decisions',
		'docs',
		'checks',
		'ui',
		'activity',
		'files',
		'discussion'
	] as const;
	type Tab = (typeof TABS)[number];
	const TAB_LABEL: Record<Tab, string> = {
		plan: 'Plan',
		decisions: 'Decisions',
		docs: 'Documents',
		checks: 'Checks',
		ui: 'UI changes',
		activity: 'Activity',
		files: 'Files',
		discussion: 'Discussion'
	};

	// -- STATES -- //

	let statusOpen = $state(false);
	let nextStatus = $state('');
	let note = $state('');
	let statusError = $state('');
	let renaming = $state(false);
	let title = $state('');
	let renameError = $state('');
	let trashing = $state(false);
	let busy = $state(false);
	let stale = $state<string | null>(null);

	// -- REACTIVE STATES -- //

	const d = $derived(data.detail as ItemView | null);

	// The streamed part (discussion, files, activity) is kept as the last answer that arrived. Every change in the project
	// fetches a new promise, and a promise that is still pending would swap the tab for a skeleton and throw away a comment
	// being written. The old answer stays on screen until the new one replaces it.
	type Extras = NonNullable<Awaited<NonNullable<PageProps['data']['extras']>>>;
	let extrasShown = $state<Extras | null>(null);
	let extrasFailed = $state(false);
	let extrasFor = $state('');
	$effect(() => {
		const promise = data.extras;
		const forItem = (data.detail as ItemView | null)?.item.id ?? '';
		// A different item never shows the last item's discussion
		if (forItem !== extrasFor) {
			extrasShown = null;
			extrasFailed = false;
		}
		if (!promise) {
			extrasShown = null;
			return;
		}
		let current = true;
		promise.then(
			(x) => {
				if (!current) return;
				extrasShown = x as Extras;
				extrasFor = forItem;
				extrasFailed = false;
			},
			() => {
				if (current && !extrasShown) extrasFailed = true;
			}
		);
		return () => {
			current = false;
		};
	});
	const org = $derived(page.params.org ?? '');
	const tab = $derived<Tab>(
		(TABS as readonly string[]).includes(page.url.searchParams.get('tab') ?? '')
			? (page.url.searchParams.get('tab') as Tab)
			: 'plan'
	);
	const env = $derived<TabEnv>({
		org,
		canWrite: d?.caps.includes('write') ?? false,
		canComment: d?.caps.includes('comment') ?? false,
		onchanged: () => invalidate('afb:project')
	});
	const counts = $derived<Partial<Record<Tab, number>>>({
		plan: d?.item.totalSteps ?? 0,
		decisions: d?.decisions.length ?? 0,
		docs: d?.sections.length ?? 0
	});

	// -- FUNCTIONS -- //

	const tabHref = (t: Tab) => (t === 'plan' ? page.url.pathname : `${page.url.pathname}?tab=${t}`);

	async function changeStatus() {
		if (!d) return;
		statusError = '';
		busy = true;
		try {
			await api(org, `/items/${d.item.ref}/status`, {
				body: { status: nextStatus, note: note.trim() },
				key: newKey()
			});
			statusOpen = false;
			note = '';
			await invalidate('afb:project');
		} catch (e) {
			statusError = e instanceof ApiError ? e.message : 'The status was not changed.';
		} finally {
			busy = false;
		}
	}

	async function rename() {
		if (!d) return;
		renameError = '';
		busy = true;
		try {
			await api(org, `/items/${d.item.ref}`, {
				method: 'PATCH',
				body: { title: title.trim(), expectVersion: d.item.version },
				key: newKey()
			});
			renaming = false;
			await invalidate('afb:project');
		} catch (e) {
			if (e instanceof ApiError && e.code === 'STALE_VERSION') {
				renaming = false;
				stale = String((e.details as { changedAt?: string } | undefined)?.changedAt ?? '');
			} else renameError = e instanceof ApiError ? e.message : 'The title was not changed.';
		} finally {
			busy = false;
		}
	}

	async function trash() {
		if (!d) return;
		busy = true;
		try {
			await api(org, `/items/${d.item.ref}`, { method: 'DELETE' });
			toast.success(`${d.item.ref} is in the trash for 30 days.`, {
				label: 'Undo',
				run: async () => {
					await api(org, `/items/${d!.item.ref}/restore`, { method: 'POST', body: {} });
					toast.success('Restored.');
				}
			});
			await goto(`/${org}/${d.project.key}`);
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The item was not moved.');
			trashing = false;
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{d ? `${d.item.ref} ${d.item.title}` : 'Item'}</title></svelte:head>

{#if data.denied}
	<div class="mx-auto max-w-[720px] px-4 py-6 max-sm:px-3.5">
		<PermissionDenied needed={data.denied.needed} current={data.denied.role} what="this item" />
	</div>
{:else if d}
	<div class="mx-auto flex max-w-[960px] flex-col gap-4 px-4 py-6 max-sm:px-3.5">
		<a href={`/${org}/${d.project.key}`} class="text-sm text-accent-text hover:underline"
			>{d.project.name}</a
		>

		<header class="flex flex-col gap-3">
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0">
					<div class="flex items-center gap-2 font-mono text-xs text-muted" data-testid="item-ref">
						{d.item.ref}
						{#if d.item.visibility === 'private'}<Lock size={12} aria-label="Private" />{/if}
						{#if d.item.tabName}<span>{d.item.tabName}</span>{/if}
					</div>
					<h1
						class="text-xl leading-7 font-semibold sm:text-2xl sm:leading-8"
						data-testid="page-title"
					>
						{d.item.title}
					</h1>
				</div>
				{#if env.canWrite}
					<ActionMenu
						label="Item actions"
						items={[
							{
								label: 'Rename',
								icon: PencilSimple,
								onselect: () => {
									title = d.item.title;
									renameError = '';
									renaming = true;
								}
							},
							{
								label: 'Move to trash',
								icon: Trash,
								danger: true,
								onselect: () => (trashing = true)
							}
						]}
					/>
				{/if}
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<span data-testid="item-status">
					<Badge tone={STATUS_TONE[d.item.status as Status]} dot
						>{d.item.status.toLowerCase()}</Badge
					>
				</span>
				{#if env.canWrite}
					<Button
						size="sm"
						onclick={() => {
							nextStatus = d.item.status;
							note = '';
							statusError = '';
							statusOpen = true;
						}}
						data-testid="change-status">Change status</Button
					>
				{/if}
				{#each d.running as r (r.sessionId)}
					<RunningBadge tool={r.tool} title={r.title} phase={r.phase ?? undefined} />
				{/each}
			</div>
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<Progress value={d.item.percent} label={`${d.item.ref} progress`} class="max-w-64" />
				<span class="text-sm text-muted tabular-nums" data-testid="item-percent"
					>{d.item.percent}%, {d.item.doneSteps} of {d.item.totalSteps} steps</span
				>
				{#if d.item.openManual > 0}
					<span class="text-xs text-muted">{d.item.openManual} manual checks open</span>
				{/if}
			</div>
		</header>

		{#if d.item.health.drift.length}
			<ul
				class="flex flex-col gap-1 rounded-lg border border-line bg-warning-soft px-3 py-2 text-sm text-warning"
				data-testid="drift"
			>
				{#each d.item.health.drift as code (code)}
					<li>{DRIFT_TEXT[code] ?? code}</li>
				{/each}
			</ul>
		{/if}

		{#if d.unrecorded.length}
			<div
				class="flex flex-col gap-1 rounded-lg border border-line bg-warning-soft px-3 py-2 text-sm text-warning"
				data-testid="unrecorded-commits"
			>
				<span
					>{d.unrecorded.length}
					{d.unrecorded.length === 1 ? 'commit has' : 'commits have'} no recorded step. Record the finished
					steps.</span
				>
				{#each d.unrecorded.slice(0, 5) as c (c.sha)}
					<span class="text-xs"><span class="font-mono">{c.sha.slice(0, 7)}</span> {c.message}</span
					>
				{/each}
			</div>
		{/if}

		<nav class="-mx-4 overflow-x-auto px-4 max-sm:-mx-3.5 max-sm:px-3.5" aria-label="Item sections">
			<ul class="flex min-w-max gap-1 border-b border-line">
				{#each TABS.filter((t) => (t !== 'checks' && t !== 'ui') || d.project.webApp) as t (t)}
					<li>
						<a
							href={tabHref(t)}
							aria-current={tab === t ? 'page' : undefined}
							data-testid={`tab-${t}`}
							class="flex min-h-11 items-center gap-1.5 border-b-2 border-transparent px-3 text-sm text-muted hover:text-ink aria-[current=page]:border-accent aria-[current=page]:font-medium aria-[current=page]:text-ink"
						>
							{TAB_LABEL[t]}
							{#if (counts[t] ?? 0) > 0}<span class="text-xs tabular-nums">{counts[t]}</span>{/if}
						</a>
					</li>
				{/each}
			</ul>
		</nav>

		{#if tab === 'plan'}
			<PlanTab detail={d} {env} />
		{:else if tab === 'decisions'}
			{#await import('#lib/board/item/DecisionsTab.svelte') then m}<m.default
					detail={d}
					{env}
				/>{/await}
		{:else if tab === 'docs'}
			{#await import('#lib/board/item/DocsTab.svelte') then m}<m.default detail={d} {env} />{/await}
		{:else if tab === 'checks' && d.project.webApp}
			{#await import('#lib/board/item/ChecksTab.svelte') then m}<m.default
					detail={d}
					{env}
				/>{/await}
		{:else if tab === 'ui' && d.project.webApp}
			{#await import('#lib/board/item/UiChangesTab.svelte') then m}<m.default
					detail={d}
					{env}
				/>{/await}
		{:else}
			<!-- Discussion, files and activity arrive after the first paint, so a skeleton holds their place -->
			{#if extrasShown && extrasFor === d.item.id}
				{@const x = extrasShown}
				{#if tab === 'activity'}
					<EventList events={x.events} {org} canUndo={env.canWrite} onchanged={env.onchanged} />
				{:else if tab === 'files'}
					{#await import('#lib/board/item/FilesTab.svelte') then m}<m.default
							detail={d}
							extras={x}
							{env}
						/>{/await}
				{:else}
					{#await import('#lib/board/item/DiscussionTab.svelte') then m}<m.default
							detail={d}
							extras={x}
							{env}
						/>{/await}
				{/if}
			{:else if extrasFailed}
				<ErrorState
					message="This part of the item did not load."
					onretry={() => invalidate('afb:project')}
				/>
			{:else}
				<div data-testid="extras-loading"><Skeleton lines={4} /></div>
			{/if}
		{/if}
	</div>

	<ResponsiveModal
		open={statusOpen}
		onclose={() => (statusOpen = false)}
		title="Change the status"
		size="sm"
		{busy}
	>
		<form
			class="flex flex-col gap-3"
			onsubmit={(e) => {
				e.preventDefault();
				void changeStatus();
			}}
		>
			<Select
				label="New status"
				bind:value={nextStatus}
				options={STATUSES.map((s) => ({ value: s, label: s.toLowerCase() }))}
			/>
			<TextField
				label="Why is it changing"
				bind:value={note}
				hint="A short note for the activity log."
				error={statusError}
				data-testid="status-note"
			/>
			<div class="flex justify-end gap-2">
				<Button onclick={() => (statusOpen = false)} disabled={busy}>Cancel</Button>
				<Button type="submit" variant="primary" loading={busy} data-testid="status-submit"
					>Change status</Button
				>
			</div>
		</form>
	</ResponsiveModal>

	<ResponsiveModal
		open={renaming}
		onclose={() => (renaming = false)}
		title="Rename the item"
		size="sm"
		{busy}
	>
		<form
			class="flex flex-col gap-3"
			onsubmit={(e) => {
				e.preventDefault();
				void rename();
			}}
		>
			<TextField label="Title" bind:value={title} error={renameError} required />
			<div class="flex justify-end gap-2">
				<Button onclick={() => (renaming = false)} disabled={busy}>Cancel</Button>
				<Button type="submit" variant="primary" loading={busy}>Save</Button>
			</div>
		</form>
	</ResponsiveModal>

	<ConfirmDialog
		open={trashing}
		onclose={() => (trashing = false)}
		title="Move this item to the trash"
		confirmLabel="Move to trash"
		tone="danger"
		onconfirm={trash}
	>
		{d.item.ref} stays in the trash for 30 days. You can restore it from there.
	</ConfirmDialog>

	<StaleWriteDialog
		open={stale !== null}
		onclose={() => (stale = null)}
		changedBy="Someone"
		changedAt={stale ? new Date(stale).toLocaleString('en') : ''}
		onreload={async () => {
			stale = null;
			await invalidate('afb:project');
		}}
		oncompare={() => (stale = null)}
	/>
{/if}
