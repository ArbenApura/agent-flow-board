<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	import type { itemShots } from '#lib/server/ops/uiShots.js';
	// -- DEP-MODULES -- //
	import { onMount } from 'svelte';
	// -- MODULES -- //
	import { ApiError, api } from '#lib/board/api.js';
	import {
		sameLook,
		screensOf,
		shotsTabState,
		since,
		viewOptions,
		viewportLabel
	} from '#lib/shared/shotsTab.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Camera from '@lucide/svelte/icons/camera';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	// -- COMPONENTS -- //
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';

	// -- TYPES -- //

	type View = Awaited<ReturnType<typeof itemShots>>;
	type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'running';

	// -- REQUIRED PROPS -- //

	let { detail, env }: { detail: ItemView; env: TabEnv } = $props();

	// -- CONSTANTS -- //

	/** The badge beside the title says in one word what the newest capture is doing. */
	const BADGE: Record<string, { label: string; tone: Tone }> = {
		waiting: { label: 'Waiting', tone: 'info' },
		running: { label: 'Running', tone: 'running' },
		failed: { label: 'Failed', tone: 'danger' },
		offline: { label: 'Not connected', tone: 'warning' },
		done: { label: 'Captured', tone: 'success' },
		'up-to-date': { label: 'Up to date', tone: 'success' },
		unchanged: { label: 'Nothing changed', tone: 'neutral' }
	};

	// -- STATES -- //

	let view = $state<View | null>(null);
	let failed = $state(false);
	let busy = $state(false);
	let now = $state(Date.now());
	// The colour and width the pictures are shown in: desktop first, and the person's own mode
	let viewport = $state('1440');
	let theme = $state('light');
	// A capture picked from the earlier ones, by id
	let pickedId = $state('');
	// The picture open at full size. Its data stays while the dialog closes, so nothing flashes blank
	let zoomOpen = $state(false);
	let zoom = $state<{ src: string; title: string; alt: string } | null>(null);

	// -- REACTIVE STATES -- //

	const tab = $derived(
		shotsTabState({
			runs: view?.runs ?? [],
			canWrite: env.canWrite,
			toolOnline: view?.toolOnline ?? false,
			canSeePictures: view?.canSeePictures ?? false,
			now
		})
	);
	const waiting = $derived(tab.key === 'waiting' || tab.key === 'running');
	const captures = $derived((view?.runs ?? []).filter((r) => r.state === 'done' && r.screens > 0));
	const picked = $derived(captures.find((r) => r.id === pickedId) ?? null);
	// A picked capture that newer ones have replaced is gone: the newest is shown, and it is said
	const pickedGone = $derived(pickedId !== '' && !picked && tab.shown !== null);
	const shown = $derived(picked ?? captures.find((r) => r.id === tab.shown?.id) ?? null);
	const earlier = $derived(captures.filter((r) => r.id !== shown?.id).slice(0, 2));
	const options = $derived(shown ? viewOptions(shown.results) : { themes: [], viewports: [] });
	const screens = $derived(
		shown ? screensOf(shown.results, { theme, viewport: Number(viewport) }) : []
	);
	const sums = $derived(view?.sums ?? {});
	const changed = $derived(screens.filter((s) => !sameLook(s, sums)));
	const same = $derived(screens.filter((s) => sameLook(s, sums)));
	const hasDetails = $derived(
		Boolean(shown && (shown.notes.length || shown.outsideCalls || shown.abortedWrites))
	);

	// -- REACTIVE STATEMENTS -- //

	// A capture is looked at again every few seconds while it waits or runs, and nothing is asked while nothing is going on
	$effect(() => {
		void detail.item.ref;
		void load();
	});
	$effect(() => {
		if (!waiting) return;
		const t = setInterval(() => void load(), 3000);
		return () => clearInterval(t);
	});
	// The colour and width always name a picture that exists: a capture that has none for the chosen ones falls back to the first it has
	$effect(() => {
		if (options.viewports.length && !options.viewports.includes(Number(viewport)))
			viewport = String(options.viewports[0]);
		if (options.themes.length && !options.themes.includes(theme)) theme = options.themes[0];
	});

	// -- FUNCTIONS -- //

	async function load() {
		try {
			view = await api<View>(env.org, `/items/${detail.item.ref}/ui-shots`);
			failed = false;
		} catch {
			failed = true;
		}
	}

	/** Asks for fresh pictures. The tab changes by itself to say it is waiting, so no toast is needed for a success. */
	async function capture() {
		busy = true;
		try {
			const r = await api<{ unavailable: boolean; reason: string | null }>(
				env.org,
				`/items/${detail.item.ref}/ui-shots`,
				{ body: { target: 'preview', force: true } }
			);
			if (r.unavailable && r.reason) toast.warning(r.reason);
			// The newest capture is what a person asks for, so an earlier one they were looking at is let go
			pickedId = '';
			await load();
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The capture was not asked for. Try again.');
		} finally {
			busy = false;
		}
	}

	const image = (id: string) => `/${env.org}/shot/${id}`;

	function open(id: string, page: string, label: string) {
		zoom = { src: image(id), title: `${page}, ${label}`, alt: `${label}: ${page}` };
		zoomOpen = true;
	}

	const short = (sha: string | null) => (sha ? sha.slice(0, 7) : '');

	// -- LIFECYCLES -- //

	onMount(() => {
		// Pictures open in the colours the person is looking at now, and the sentences about time stay true
		const mode = document.documentElement.dataset.mode;
		if (mode === 'light' || mode === 'dark') theme = mode;
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});
</script>

{#snippet figure(id: string | null, page: string, label: string, missing: string)}
	<figure class="flex min-w-0 flex-col gap-1">
		{#if id}
			<button
				type="button"
				onclick={() => open(id, page, label)}
				aria-label={`Open the ${label.toLowerCase()} picture of ${page} full size`}
				class="group relative block cursor-pointer overflow-hidden rounded-lg border border-line bg-raised p-0 text-left"
			>
				<img src={image(id)} alt={`${label}: ${page}`} loading="lazy" class="block h-auto w-full" />
				<span
					class="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-md bg-surface px-2 py-1 text-xs font-medium text-ink opacity-0 shadow-[var(--elev-1)] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
				>
					<Maximize2 size={14} aria-hidden="true" /> Full size
				</span>
			</button>
		{:else}
			<div
				class="grid min-h-28 place-items-center rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-muted"
			>
				{missing}
			</div>
		{/if}
		<figcaption class="text-xs font-medium text-muted">{label}</figcaption>
	</figure>
{/snippet}

<div class="flex flex-col gap-6" data-testid="ui-tab">
	{#if failed && !view}
		<ErrorState message="The UI shots did not load." onretry={load} />
	{:else if !view}
		<Skeleton lines={4} />
	{:else}
		<!-- WHAT THE NEWEST CAPTURE IS DOING, AND THE ONE BUTTON -->
		<TabCard role="region" aria-label="UI shots">
			{#snippet heading()}UI shots{/snippet}
			{#snippet meta()}
				{#if BADGE[tab.key]}
					<Badge tone={BADGE[tab.key].tone}>{BADGE[tab.key].label}</Badge>
				{/if}
			{/snippet}
			<div class="flex flex-col gap-3 p-4 max-sm:p-3.5">
				<p class="text-sm" role="status" data-testid="shots-sentence">{tab.sentence}</p>
				{#if tab.button.show}
					<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
						<Button
							variant="primary"
							loading={busy}
							disabled={tab.button.disabled}
							onclick={capture}
							data-testid="capture-screens"
						>
							<Camera size={16} aria-hidden="true" /> Capture screens
						</Button>
						{#if tab.button.reason}
							<span class="min-w-0 flex-1 text-xs text-muted">{tab.button.reason}</span>
						{/if}
					</div>
				{/if}
				{#if shown?.beforeCommit || shown?.afterCommit}
					<p class="text-xs text-muted">
						Compared: the last commit
						{#if shown.beforeCommit}<span class="font-mono">{short(shown.beforeCommit)}</span>{/if}
						with your changes
						{#if shown.afterCommit}<span class="font-mono">on {short(shown.afterCommit)}</span>{/if}
					</p>
				{/if}
			</div>
		</TabCard>

		<!-- THE PICTURES: ONE CAPTURE AT A TIME, AT ONE WIDTH AND IN ONE COLOUR -->
		{#if shown}
			<section
				class="flex flex-col gap-4"
				aria-labelledby="shots-pictures"
				data-testid="ui-results"
			>
				<h2 id="shots-pictures" class="sr-only">Pictures of the captured screens</h2>
				{#if pickedGone}
					<p class="text-xs text-muted">
						That capture was replaced by newer ones, so the newest is shown.
					</p>
				{:else if picked}
					<div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
						An earlier capture, taken {since(shown.createdAt, now)}.
						<Button size="sm" variant="ghost" onclick={() => (pickedId = '')}
							>Show the newest</Button
						>
					</div>
				{:else if view.runs[0] && view.runs[0].id !== shown.id}
					<p class="text-xs text-muted">
						These pictures are from the capture {since(shown.createdAt, now)}.
					</p>
				{/if}
				<div class="flex flex-wrap items-end gap-x-6 gap-y-3">
					{#if options.viewports.length > 1}
						<div class="flex flex-col gap-1">
							<span class="text-xs font-medium text-muted">Screen size</span>
							<SegmentedControl
								label="Screen size"
								options={options.viewports.map((v) => ({
									value: String(v),
									label: viewportLabel(v)
								}))}
								bind:value={viewport}
							/>
						</div>
					{/if}
					{#if options.themes.length > 1}
						<div class="flex flex-col gap-1">
							<span class="text-xs font-medium text-muted">Picture colours</span>
							<SegmentedControl
								label="Picture colours"
								options={options.themes.map((t) => ({
									value: t,
									label: t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : t
								}))}
								bind:value={theme}
							/>
						</div>
					{/if}
				</div>

				{#each changed as s (s.key)}
					<TabCard role="region" aria-label={s.page} data-testid="ui-page">
						{#snippet heading()}
							<span class="font-mono text-sm font-medium break-words">{s.page}</span>
						{/snippet}
						{#snippet actions()}
							{#if !s.before && shown.beforeTarget === 'base'}<Badge tone="info">New screen</Badge
								>{/if}
						{/snippet}
						<div class="grid gap-3 p-4 max-sm:p-3.5 sm:grid-cols-2">
							{@render figure(
								s.before,
								s.page,
								'Before',
								shown.beforeTarget === 'base'
									? 'New screen: it did not exist before.'
									: 'No Before in this capture. The notes say why.'
							)}
							{@render figure(s.after, s.page, 'After', 'No picture was taken of this screen.')}
						</div>
					</TabCard>
				{/each}

				{#if same.length > 0}
					<Notice tone="info">
						{same.length === 1 ? '1 screen looks' : `${same.length} screens look`} the same as before:
						<span class="font-mono break-words">{same.map((s) => s.page).join(', ')}</span>
					</Notice>
				{/if}
				{#if screens.length === 0}
					<p class="text-sm text-muted">This capture has no pictures at this size and colour.</p>
				{/if}
			</section>

			{#if earlier.length > 0}
				<TabCard
					collapsible
					startCollapsed
					storageKey={`afb:collapse:${env.org}:${detail.item.id}:shots-earlier`}
					role="region"
					aria-label="Earlier captures"
				>
					{#snippet heading()}Earlier captures{/snippet}
					{#snippet meta()}<span class="text-sm text-muted tabular-nums">{earlier.length}</span
						>{/snippet}
					<ul>
						{#each earlier as r (r.id)}
							<li
								class="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2 last:border-b-0 max-sm:px-3.5"
								data-row
							>
								<span class="min-w-0 flex-1 text-sm">
									{r.screens} screen{r.screens === 1 ? '' : 's'}
									<span class="text-xs text-muted">{since(r.createdAt, now)}</span>
								</span>
								<Button size="sm" onclick={() => (pickedId = r.id)}>Show</Button>
							</li>
						{/each}
					</ul>
				</TabCard>
			{/if}

			{#if hasDetails}
				<TabCard
					collapsible
					startCollapsed
					storageKey={`afb:collapse:${env.org}:${detail.item.id}:shots-details`}
					role="region"
					aria-label="Details"
				>
					{#snippet heading()}Details{/snippet}
					<div class="flex flex-col gap-2 p-4 text-sm max-sm:p-3.5">
						{#if shown.notes.length > 0}
							<ul class="flex flex-col gap-1">
								{#each shown.notes as note, i (i)}
									<li>{note}</li>
								{/each}
							</ul>
						{/if}
						{#if shown.abortedWrites > 0}
							<p class="text-xs text-muted">
								{shown.abortedWrites === 1
									? 'A change the pages tried to make was'
									: `${shown.abortedWrites} changes the pages tried to make were`} blocked, so nothing
								in your app was touched.
							</p>
						{/if}
						{#if shown.outsideCalls > 0}
							<p class="text-xs text-muted">
								{shown.outsideCalls === 1 ? 'A request' : `${shown.outsideCalls} requests`} to other addresses
								{shown.outsideCalls === 1 ? 'was' : 'were'} blocked.
							</p>
						{/if}
					</div>
				</TabCard>
			{/if}
		{/if}
	{/if}
</div>

<!-- THE PICTURE AT FULL SIZE. ALWAYS MOUNTED WITH open, SO IT CLOSES WITH ITS TRANSITION -->
<ResponsiveModal
	open={zoomOpen}
	onclose={() => (zoomOpen = false)}
	title={zoom?.title ?? ''}
	size="lg"
>
	{#if zoom}
		<img src={zoom.src} alt={zoom.alt} class="block h-auto w-full rounded-lg border border-line" />
	{/if}
	{#snippet footer()}
		{#if zoom}
			<Button href={zoom.src} target="_blank" rel="noopener">Open in a new tab</Button>
		{/if}
	{/snippet}
</ResponsiveModal>
