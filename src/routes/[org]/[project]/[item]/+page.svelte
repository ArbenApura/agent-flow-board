<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- ENVS -- //
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { itemTabsFrom, parseItemTab } from '#lib/board/item/itemTabs.js';
	import ItemTabs from '#lib/board/item/ItemTabs.svelte';
	import { clearCache } from '#lib/board/swr.js';
	import VisibilityPill from '#lib/board/item/VisibilityPill.svelte';
	import ContinueDialog from '#lib/board/ContinueDialog.svelte';
	import EventList from '#lib/board/EventList.svelte';
	import PlanTab from '#lib/board/item/PlanTab.svelte';
	import NotesCard from '#lib/board/notes/NotesCard.svelte';
	import {
		DRIFT_TEXT,
		ago,
		STATUSES,
		STATUS_STYLE,
		STATUS_TONE,
		type Status
	} from '#lib/board/status.js';
	import {
		ACTION_LABEL,
		CONTINUE_ACTIONS,
		parseMode,
		parseTool,
		type ContinueAction
	} from '#lib/shared/continue.js';
	import ActionMenu from '#lib/ui/ActionMenu.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PhaseStepper from '#lib/ui/PhaseStepper.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import ProgressRing from '#lib/ui/ProgressRing.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import StaleWriteDialog from '#lib/ui/StaleWriteDialog.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Check from '@lucide/svelte/icons/check';
	import CheckCheck from '@lucide/svelte/icons/check-check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Copy from '@lucide/svelte/icons/copy';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import MessageCircle from '@lucide/svelte/icons/message-circle';
	import Play from '@lucide/svelte/icons/play';
	import Target from '@lucide/svelte/icons/target';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash from '@lucide/svelte/icons/trash';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- STATES -- //

	let statusOpen = $state(false);
	let continueOpen = $state(false);
	let continueAction = $state<ContinueAction>('resume');
	let refCopied = $state(false);
	let refTimer: ReturnType<typeof setTimeout> | undefined;
	let renaming = $state(false);
	let title = $state('');
	let renameError = $state('');
	let trashing = $state(false);
	let busy = $state(false);
	let stale = $state<string | null>(null);

	// -- REACTIVE STATES -- //

	const d = $derived(data.detail as ItemView | null);
	// "Continue with" hands the item to the person's coding tool. Not for a closed item.
	const continueTool = $derived(parseTool(data.continueTool));
	const ACTION_ICON = {
		resume: Play,
		ask: MessageCircle,
		audit: CheckCheck,
		critic: Target,
		interview: CircleHelp
	};
	function openContinue(a: ContinueAction) {
		continueAction = a;
		continueOpen = true;
	}
	// An item with no creator was made by the system, and one whose creator left the organisation has no name to show
	const creatorName = $derived(
		d?.creator?.name ?? (d?.item.createdBy ? 'Former member' : 'System')
	);
	const createdFull = $derived(d ? new Date(d.item.createdAt).toLocaleString('en') : '');
	const continueItem = $derived(
		d ? { ref: d.item.ref, title: d.item.title, href: page.url.pathname } : null
	);
	const canContinue = $derived(
		!!d &&
			(d.caps.includes('write') ?? false) &&
			d.item.status !== 'COMPLETED' &&
			d.item.status !== 'REMOVED'
	);

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
	const tab = $derived(parseItemTab(page.url.searchParams.get('tab')));
	const env = $derived<TabEnv>({
		org,
		canWrite: d?.caps.includes('write') ?? false,
		canComment: d?.caps.includes('comment') ?? false,
		onchanged: () => invalidate('afb:project')
	});
	// The tabs and their counts come from the same helper as the top bar's copy, so the two can never drift
	const tabsView = $derived(itemTabsFrom(page.route.id, data, page.url.searchParams));

	// -- FUNCTIONS -- //

	// Sentence case for display: 'IN REVIEW' reads as 'In review'
	const statusLabel = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

	// Copies the item reference and shows a tick on the button for a moment
	async function copyRef() {
		if (!d) return;
		try {
			await navigator.clipboard.writeText(d.item.ref);
			toast.success(`${d.item.ref} copied.`);
			refCopied = true;
			clearTimeout(refTimer);
			refTimer = setTimeout(() => (refCopied = false), 1600);
		} catch {
			toast.warning('Copy did not work here. Select the reference and copy it by hand.');
		}
	}

	// The API needs a note of 3 characters or more, so the page sends a fixed one, as the plan board does
	async function changeStatus(next: Status) {
		if (!d || next === d.item.status) return;
		busy = true;
		try {
			await toast.promise(
				api(org, `/items/${d.item.ref}/status`, {
					body: { status: next, note: 'Changed on the item page' },
					key: newKey()
				}),
				{
					id: 'item-status',
					loading: 'Changing the status...',
					success: `Status is now ${next.toLowerCase()}.`,
					error: (e) => (e instanceof ApiError ? e.message : 'The status was not changed.')
				}
			);
			await invalidate('afb:project');
		} catch {
			// The promise toast already shows the failure
		} finally {
			busy = false;
		}
	}

	async function rename() {
		if (!d) return;
		renameError = '';
		busy = true;
		try {
			await toast.promise(
				api(org, `/items/${d.item.ref}`, {
					method: 'PATCH',
					body: { title: title.trim(), expectVersion: d.item.version },
					key: newKey()
				}),
				{
					id: 'item-rename',
					loading: 'Saving the title...',
					success: 'Title changed.',
					error: (e) =>
						e instanceof ApiError && e.code === 'STALE_VERSION'
							? 'Someone else changed this item first.'
							: e instanceof ApiError
								? e.message
								: 'The title was not changed.'
				}
			);
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

	// Only the creator gets here: the server refuses anyone else with FORBIDDEN
	async function setVisibility(next: 'public' | 'private') {
		if (!d) return;
		try {
			await toast.promise(
				api(org, `/items/${d.item.ref}`, {
					method: 'PATCH',
					body: { visibility: next, expectVersion: d.item.version },
					key: newKey()
				}),
				{
					id: 'item-visibility',
					loading: 'Saving...',
					success: next === 'private' ? 'This item is now private.' : 'This item is now public.',
					error: (e) =>
						e instanceof ApiError && e.code === 'STALE_VERSION'
							? 'Someone else changed this item first.'
							: e instanceof ApiError
								? e.message
								: 'The change was not saved.'
				}
			);
			await invalidate('afb:project');
		} catch (e) {
			if (e instanceof ApiError && e.code === 'STALE_VERSION')
				stale = String((e.details as { changedAt?: string } | undefined)?.changedAt ?? '');
		}
	}

	async function trash() {
		if (!d) return;
		busy = true;
		try {
			const ref = d.item.ref;
			await toast.promise(api(org, `/items/${ref}`, { method: 'DELETE' }), {
				loading: `Moving ${ref} to the trash...`,
				success: `${ref} is in the trash for 30 days.`,
				error: (e) => (e instanceof ApiError ? e.message : 'The item was not moved.'),
				action: {
					label: 'Undo',
					run: async () => {
						try {
							await toast.promise(api(org, `/items/${ref}/restore`, { method: 'POST', body: {} }), {
								loading: 'Restoring...',
								success: 'Restored.',
								error: 'It was not restored.'
							});
						} catch {
							// The promise toast already shows the failure
						}
					}
				}
			});
			await goto(`/${org}/${d.project.key}`);
		} catch {
			// The promise toast already shows the failure
			trashing = false;
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{d ? `${d.item.ref} ${d.item.title}` : 'Item'}</title></svelte:head>

{#if data.denied}
	<PageFrame class="py-8">
		<PermissionDenied needed={data.denied.needed} current={data.denied.role} what="this item" />
	</PageFrame>
{:else if d}
	<PageFrame class="flex flex-col gap-5 pb-12">
		<header
			class="enter relative mt-6 flex flex-col gap-5 overflow-hidden rounded-2xl border border-line bg-band px-6 py-5 shadow-[var(--elev-1)] max-sm:px-4"
		>
			<svg
				viewBox="0 0 240 120"
				class="pointer-events-none absolute -top-6 -right-8 h-40 w-80 text-accent opacity-[0.14] max-sm:hidden"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				aria-hidden="true"
			>
				<circle cx="200" cy="40" r="30" />
				<circle cx="200" cy="40" r="55" />
				<circle cx="200" cy="40" r="80" />
				<circle cx="200" cy="40" r="105" />
			</svg>
			<div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
				<div class="min-w-0 flex-1 basis-72">
					<!-- THE BREADCRUMB IN THE TOP BAR ALREADY NAMES THE PROJECT ON A WIDE SCREEN, SO THIS LINK IS FOR PHONES, WHERE THE BREADCRUMB IS HIDDEN -->
					<a
						href={`/${org}/${d.project.key}`}
						class="mb-1 inline-block text-sm text-accent-text hover:underline md:hidden"
						>{d.project.name}</a
					>
					<div
						class="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted"
						data-testid="item-ref"
					>
						<!-- CLICK TO COPY THE REFERENCE -->
						<button
							type="button"
							onclick={copyRef}
							title="Copy the reference"
							aria-label={`Copy ${d.item.ref}`}
							class="group -mx-1.5 inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-accent active:scale-[0.97] motion-reduce:transition-none"
						>
							{d.item.ref}
							{#if refCopied}
								<Check size={13} class="text-success" aria-hidden="true" />
							{:else}
								<Copy
									size={13}
									class="opacity-50 transition-opacity group-hover:opacity-100 motion-reduce:transition-none"
									aria-hidden="true"
								/>
							{/if}
						</button>
						<!-- PRIVATE OR PUBLIC: A BUTTON FOR THE PERSON WHO MADE THE ITEM, PLAIN TEXT FOR EVERYONE ELSE -->
						<VisibilityPill
							visibility={d.item.visibility === 'private' ? 'private' : 'public'}
							canChange={d.canSetVisibility}
							onchange={setVisibility}
						/>
						{#if d.item.tabName}<span
								class="rounded-md border border-line px-1.5 py-0.5 leading-none"
								title="The name this item gives a coding session">{d.item.tabName}</span
							>{/if}
					</div>
				</div>
				<!-- THE WORKFLOWS A CODING TOOL CAN RUN FOR THIS ITEM. RESUME IS THE ONE PRIMARY ACTION OF THE PAGE -->
				<!-- ON A PHONE THE FIVE BUTTONS AND THE ITEM MENU ARE ONE OUTLINED GRID OF THREE COLUMNS: HAIRLINES BETWEEN THE CELLS, THE CELLS TAKE THE COLOUR OF THE BAND. FROM SM UP THIS WRAPPER LAYS NOTHING OUT -->
				<div
					class="contents max-sm:grid max-sm:basis-full max-sm:grid-cols-3 max-sm:gap-px max-sm:overflow-hidden max-sm:rounded-xl max-sm:border max-sm:border-line max-sm:bg-line"
				>
					{#if canContinue}
						<div
							class="flex flex-wrap items-center gap-2 max-sm:contents"
							role="group"
							aria-label="Continue with a coding tool"
							data-testid="continue-actions"
						>
							{#each CONTINUE_ACTIONS as a (a)}
								{@const Icon = ACTION_ICON[a]}
								<Button
									size="sm"
									variant="subtle"
									class={cn(
										'max-sm:w-full max-sm:rounded-none max-sm:border-0 max-sm:bg-band',
										a === 'resume' && 'max-sm:[&_svg]:text-accent'
									)}
									onclick={() => openContinue(a)}
									data-testid={`continue-${a}`}
								>
									<Icon size={16} aria-hidden="true" />
									{ACTION_LABEL[a]}
								</Button>
							{/each}
						</div>
					{/if}
					{#if env.canWrite}
						<!-- THE SIXTH CELL OF THE PHONE GRID: THE MENU BUTTON FILLS IT -->
						<div
							class="flex max-sm:bg-band max-sm:[&_button]:size-full max-sm:[&_button]:rounded-none max-sm:[&>span]:w-full"
						>
							<ActionMenu
								size="sm"
								label="Item actions"
								items={[
									{
										label: 'Rename',
										icon: Pencil,
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
						</div>
					{/if}
				</div>
			</div>

			<!-- THE TITLE AND WHO MADE THE ITEM USE THE FULL WIDTH OF THE HEADER, UNDER THE REFERENCE LINE AND THE ACTIONS -->
			<div class="-mt-2 min-w-0">
				<h1 class="text-xl font-semibold tracking-tight sm:text-2xl" data-testid="page-title">
					{d.item.title}
				</h1>
				<!-- WHO MADE THE ITEM AND WHEN, A QUIET LINE UNDER THE TITLE -->
				<p
					class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted"
					data-testid="item-creator"
				>
					<span>Created by <span class="font-medium text-ink">{creatorName}</span></span>
					<span aria-hidden="true">·</span>
					<time datetime={new Date(d.item.createdAt).toISOString()} title={createdFull}
						>{ago(d.item.createdAt)}<span class="sr-only">, {createdFull}</span></time
					>
				</p>
			</div>

			<!-- THE SUMMARY BAND. THE RING, THE STATUS AND WHO IS RUNNING IT -->
			<div
				class="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-line bg-surface p-5 shadow-[var(--elev-1)] max-sm:gap-x-4 max-sm:p-4"
			>
				<ProgressRing value={d.item.percent} label={`${d.item.ref} progress`} size={48} />
				<div class="flex min-w-0 flex-col gap-1">
					<span class="text-lg font-semibold tabular-nums" data-testid="item-percent"
						>{d.item.percent}%, {d.item.doneSteps} of {d.item.totalSteps} steps</span
					>
					{#if d.item.openManual > 0}
						<span class="text-sm text-muted">{d.item.openManual} manual checks open</span>
					{/if}
				</div>
				<!-- ON A PHONE THE STATUS IS A FULL WIDTH ROW UNDER THE PERCENT: THE LABEL ON THE LEFT, THE BADGE ON THE RIGHT -->
				<div class="ml-auto flex flex-wrap items-center gap-2 max-sm:ml-0 max-sm:w-full">
					<!-- THE STATUS IS ONE CONTROL: THE PILL SHOWS IT AND, FOR A WRITER, OPENS THE LIST TO CHANGE IT -->
					<span data-testid="item-status" class="max-sm:w-full">
						{#if env.canWrite}
							<Popover
								bind:open={statusOpen}
								placement="bottom-end"
								role="menu"
								label="Change status"
								anchorClass="max-sm:flex max-sm:w-full"
							>
								{#snippet trigger({ props, toggle, open })}
									<button
										type="button"
										{...props}
										onclick={toggle}
										disabled={busy}
										aria-label={`Status ${statusLabel(d.item.status)}. Change status`}
										data-testid="change-status"
										class="group inline-flex min-h-11 cursor-pointer items-center rounded-md transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none motion-reduce:active:scale-100 max-sm:w-full max-sm:justify-between max-sm:rounded-lg max-sm:border max-sm:border-line max-sm:px-3"
									>
										<span class="text-sm text-muted sm:hidden">Status</span>
										<Badge
											tone={STATUS_TONE[d.item.status as Status]}
											dot
											class="rounded-md py-1 pr-2 text-sm group-hover:brightness-95"
										>
											{statusLabel(d.item.status)}
											<ChevronDown
												size={14}
												aria-hidden="true"
												class={cn(
													'transition-transform motion-reduce:transition-none',
													open && 'rotate-180'
												)}
											/>
										</Badge>
									</button>
								{/snippet}
								{#snippet children({ close })}
									{#each STATUSES as s (s)}
										<button
											type="button"
											role="menuitemradio"
											aria-checked={s === d.item.status}
											onclick={() => {
												close();
												void changeStatus(s);
											}}
											class="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-ink hover:bg-raised focus-visible:bg-raised focus-visible:outline-none"
										>
											<span
												class={cn('size-[8px] shrink-0 rounded-full', STATUS_STYLE[s].dot)}
												aria-hidden="true"
											></span>
											<span class="flex-1">{statusLabel(s)}</span>
											{#if s === d.item.status}<Check
													size={16}
													class="text-muted"
													aria-hidden="true"
												/>{/if}
										</button>
									{/each}
								{/snippet}
							</Popover>
						{:else}
							<Badge tone={STATUS_TONE[d.item.status as Status]} dot class="rounded-md py-1 text-sm"
								>{statusLabel(d.item.status)}</Badge
							>
						{/if}
					</span>
				</div>

				{#if d.phases.length}
					<PhaseStepper
						class="basis-full border-t border-line pt-4"
						phases={d.phases.map((ph) => ({
							key: ph.key,
							title: ph.title,
							done: ph.steps.filter((x) => x.state === 'done').length,
							// Waived and superseded steps are not counted, the same as the item's own total
							total: ph.steps.filter((x) => x.state === 'done' || x.state === 'open').length
						}))}
					/>
				{/if}
			</div>
		</header>

		{#if d.item.health.drift.length}
			<ul
				class="flex flex-col gap-1 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning"
				data-testid="drift"
			>
				{#each d.item.health.drift as code (code)}
					<li>{DRIFT_TEXT[code] ?? code}</li>
				{/each}
			</ul>
		{/if}

		<!-- THE TAB BAR. A CARD THE SAME WIDTH AS THE HEADER ABOVE IT, STICKING JUST UNDER THE TOP BAR (56 PX PLUS ITS LINE, 64 PX PLUS ITS LINE FROM MD) WITH A GAP. THE GAP IS FILLED WITH THE PAGE COLOUR SO SCROLLED TEXT DOES NOT SHOW THROUGH THE TRANSLUCENT TOP BAR -->
		<!-- A MATCHING STRIP UNDER THE BAR (AFTER:) KEEPS THE 8 PX BELOW IT CLEAN TOO, WHERE THE STICKY BLOCKS OF A TAB STOP (131 PX). BOTH STRIPS ARE 9 PX SO THEY ALSO COVER THE BAR'S 1 PX BORDER -->
		<nav
			aria-label="Item sections"
			class="sticky top-[65px] z-20 rounded-xl border border-line bg-surface p-1 shadow-[var(--elev-1)] before:pointer-events-none before:absolute before:inset-x-0 before:-top-[9px] before:h-[9px] before:bg-[var(--bg)] after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-[9px] after:h-[9px] after:bg-[var(--bg)] md:top-[73px] 2xl:hidden"
		>
			<!-- FROM 1536 PX UP THIS CARD IS GONE (DISPLAY NONE): THE SAME TABS SIT IN THE TOP BAR OF THE LAYOUT, FROM THE SAME HELPER -->
			{#if tabsView}
				<ItemTabs
					tabs={tabsView.tabs}
					counts={tabsView.counts}
					active={tabsView.active}
					pathname={page.url.pathname}
				/>
			{/if}
		</nav>

		{#if tab === 'plan'}
			<PlanTab detail={d} {env} />
			<!-- NOTES THAT LINK TO THIS PLAN, UNDER THE PLAN -->
			<NotesCard
				{org}
				project={page.params.project ?? ''}
				target={{ kind: 'item', id: d.item.id, ref: d.item.ref }}
				role={d.role}
				canWrite={env.canWrite}
			/>
		{:else if tab === 'decisions'}
			{#await import('#lib/board/item/DecisionsTab.svelte') then m}<m.default
					detail={d}
					{env}
				/>{/await}
		{:else if tab === 'docs'}
			{#await import('#lib/board/item/DocsTab.svelte') then m}<m.default detail={d} {env} />{/await}
		{:else if tab === 'mockups' && data.mockups}
			{#await import('#lib/board/item/MockupsTab.svelte') then m}<m.default
					detail={d}
					{env}
					mockups={data.mockups}
				/>{/await}
		{:else if tab === 'checks' && d.project.webApp}
			{#await import('#lib/board/item/ChecksTab.svelte') then m}<m.default
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
					onretry={() => {
						clearCache();
						return invalidate('afb:project');
					}}
				/>
			{:else}
				<div data-testid="extras-loading"><Skeleton variant="row" lines={4} /></div>
			{/if}
		{/if}
	</PageFrame>

	<ContinueDialog
		open={continueOpen}
		onclose={() => (continueOpen = false)}
		item={continueItem}
		action={continueAction}
		tool={continueTool}
		mode={parseMode(data.continueMode)}
	/>

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
