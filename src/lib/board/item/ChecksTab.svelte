<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	import type { itemChecks } from '#lib/server/ops/checks.js';
	// -- MODULES -- //
	import { ApiError, api } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import {
		checkStatus,
		closedStep,
		failureSentence,
		resultStatus,
		seconds
	} from '#lib/shared/checksTab.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Check from '@lucide/svelte/icons/check';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Copy from '@lucide/svelte/icons/copy';
	import Download from '@lucide/svelte/icons/download';
	import ImageOff from '@lucide/svelte/icons/image-off';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Play from '@lucide/svelte/icons/play';
	// -- COMPONENTS -- //
	import Fold from '#lib/board/item/Fold.svelte';
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';

	// -- TYPES -- //

	type View = Awaited<ReturnType<typeof itemChecks>>;
	type Gallery = { ids: string[]; index: number; title: string };

	// -- REQUIRED PROPS -- //

	let { detail, env }: { detail: ItemView; env: TabEnv } = $props();

	// -- STATES -- //

	let view = $state<View | null>(null);
	let failed = $state(false);
	let busy = $state('');
	let notice = $state<Record<string, string>>({});
	// The screenshots open full size in one dialog. Its data stays while the dialog closes, so nothing flashes blank
	let zoomOpen = $state(false);
	let gallery = $state<Gallery | null>(null);
	// A screenshot whose file could not be loaded shows a plain placeholder instead of a broken picture
	let broken = $state<Record<string, boolean>>({});
	let copied = $state('');

	// -- REACTIVE STATES -- //

	// Only checks the agent wrote a browser script for are listed
	const autoChecks = $derived(detail.manualChecks.filter((c) => c.auto));
	const runner = $derived(view?.targets.find((t) => t.target === 'preview'));
	const waiting = $derived(
		view?.checks.some((c) => c.runs.some((r) => r.result === 'queued' || r.result === 'running')) ??
			false
	);
	const zoomId = $derived(gallery ? (gallery.ids[gallery.index] ?? null) : null);

	// -- REACTIVE STATEMENTS -- //

	$effect(() => {
		void detail.item.ref;
		void load();
	});

	// A run in progress is looked at again every few seconds, and nothing is asked while nothing is waiting
	$effect(() => {
		if (!waiting) return;
		const t = setInterval(() => void load(), 3000);
		return () => clearInterval(t);
	});

	// -- FUNCTIONS -- //

	async function load() {
		try {
			view = await api<View>(env.org, `/items/${detail.item.ref}/browser-checks`);
			failed = false;
			// A "could not run" notice is true only until a newer run exists
			for (const key of Object.keys(notice)) {
				const latest = view.checks.find((c) => c.key === key)?.runs[0];
				if (latest && latest.result !== 'unavailable' && latest.result !== 'timeout')
					notice[key] = '';
			}
		} catch {
			failed = true;
		}
	}

	const checkOf = (key: string) => view?.checks.find((c) => c.key === key);
	const image = (id: string) => `/${env.org}/attachment/${id}`;
	type RunFile = { id: string; filename: string; caption: string; mime: string };
	/** The pictures of a run, in the order they were saved. */
	const picturesOf = (files: RunFile[]) =>
		files.filter((f) => f.mime.startsWith('image/')).map((f) => f.id);
	/** Everything else a run saved, such as the trace and the video: opened through a short lived link. */
	const othersOf = (files: RunFile[]) => files.filter((f) => !f.mime.startsWith('image/'));

	async function openFile(id: string) {
		try {
			const link = await api<{ url: string }>(env.org, `/attachments/${id}/link`);
			window.open(link.url, '_blank', 'noopener');
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The link could not be made.');
		}
	}

	/** Asks for a run. It names no plan step: a pass closes this check and nothing else, and the card changes by itself to say it is waiting. */
	async function run(key: string) {
		busy = key;
		try {
			const asked = await api<{ unavailable: boolean; run: { reason: string | null } }>(
				env.org,
				`/items/${detail.item.ref}/browser-checks/runs`,
				{ body: { key } }
			);
			notice[key] = asked.unavailable ? (asked.run.reason ?? 'The check cannot run yet.') : '';
			await load();
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The run was not asked for. Try again.');
		} finally {
			busy = '';
		}
	}

	function openShot(ids: string[], index: number, title: string) {
		gallery = { ids, index, title };
		zoomOpen = true;
	}

	/** Steps through the screenshots of one run, wrapping around at both ends. */
	function step(by: number) {
		if (!gallery) return;
		const n = gallery.ids.length;
		gallery = { ...gallery, index: (gallery.index + by + n) % n };
	}

	function onZoomKey(e: KeyboardEvent) {
		if (!zoomOpen || !gallery || gallery.ids.length < 2) return;
		if (e.key === 'ArrowLeft') step(-1);
		else if (e.key === 'ArrowRight') step(1);
	}

	async function copyScript(key: string, script: string) {
		try {
			await navigator.clipboard.writeText(script);
			copied = key;
			setTimeout(() => {
				if (copied === key) copied = '';
			}, 1800);
		} catch {
			toast.error('The script could not be copied.');
		}
	}
</script>

<svelte:window onkeydown={onZoomKey} />

<!-- ONE RUN'S SCREENSHOTS AS A ROW OF PICTURES, EACH OPENING FULL SIZE -->
{#snippet shots(ids: string[], title: string, small: boolean)}
	{#if ids.length > 0}
		<ul
			class={small ? 'flex flex-wrap gap-2' : 'grid grid-cols-2 gap-3 max-sm:gap-2 sm:grid-cols-3'}
			data-testid="check-shots"
		>
			{#each ids as id, i (id)}
				<li class={small ? 'w-24' : 'min-w-0'}>
					{#if broken[id]}
						<div
							class="grid aspect-[16/10] place-items-center rounded-lg border border-dashed border-line text-muted"
							title="This screenshot could not be loaded"
						>
							<ImageOff size={16} aria-hidden="true" />
						</div>
					{:else}
						<button
							type="button"
							onclick={() => openShot(ids, i, title)}
							aria-label={`Open screenshot ${i + 1} of ${ids.length} full size`}
							class="group relative block aspect-[16/10] w-full cursor-pointer overflow-hidden rounded-lg border border-line bg-raised p-0 transition-colors hover:border-[var(--accent)] motion-reduce:transition-none"
						>
							<img
								src={image(id)}
								alt={`Screenshot ${i + 1} of ${ids.length}: ${title}`}
								loading="lazy"
								onerror={() => (broken[id] = true)}
								class="block h-full w-full object-cover object-top"
							/>
							{#if !small}
								<span
									class="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-md bg-surface px-2 py-1 text-xs font-medium text-ink opacity-0 shadow-[var(--elev-1)] transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
								>
									<Maximize2 size={14} aria-hidden="true" /> Full size
								</span>
							{/if}
						</button>
					{/if}
					{#if !small}
						<p class="mt-1 text-xs font-medium text-muted">Screenshot {i + 1}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<!-- THE TRACE AND VIDEO OF A RUN, AS SMALL LINKS BESIDE THE PICTURES -->
{#snippet others(files: RunFile[])}
	{@const rest = othersOf(files)}
	{#if rest.length > 0}
		<div class="flex flex-wrap items-center gap-2">
			{#each rest as f (f.id)}
				<Button size="sm" variant="ghost" onclick={() => openFile(f.id)}>
					<Download size={14} aria-hidden="true" />
					{f.caption}
				</Button>
			{/each}
		</div>
	{/if}
{/snippet}

<div class="flex flex-col gap-6" data-testid="checks-tab">
	{#if failed && !view}
		<ErrorState message="The browser checks did not load." onretry={load} />
	{:else if !view}
		<Skeleton lines={4} />
	{:else}
		<!-- THE RUNNER SHOWS ONLY WHEN IT NEEDS ATTENTION -->
		{#if !runner?.available}
			<Notice tone="warning" data-testid="runner-status">
				The check runner is not connected. Your agent connects it by itself the next time a check
				needs to run, so there is nothing to do here.
			</Notice>
		{/if}

		{#if autoChecks.length === 0}
			<EmptyState
				kind="checks"
				title="No browser checks on this item yet"
				text="Your agent adds a check when it needs to prove something on a screen. It appears here with its result and its screenshots."
			/>
		{/if}

		{#each autoChecks as mc (mc.id)}
			{@const c = checkOf(mc.key)}
			{@const latest = c?.runs[0]}
			{@const status = checkStatus(mc.state, c?.runs ?? [])}
			{@const problem = latest ? failureSentence(latest) : null}
			<TabCard role="region" aria-label={`${mc.key} ${mc.text}`} data-testid={`check-${mc.key}`}>
				{#snippet heading()}
					<span class="rounded-[6px] bg-raised px-2 py-0.5 font-mono text-xs font-medium text-muted"
						>{mc.key}</span
					>
					<span class="min-w-0 break-words">{mc.text}</span>
				{/snippet}
				{#snippet actions()}
					<Badge tone={status.tone}>{status.label}</Badge>
				{/snippet}
				<div class="flex flex-col gap-4 p-4 max-sm:p-3.5">
					{#if !c}
						<p class="text-sm text-muted">
							No browser check has been written for this yet. Your agent writes it when it needs to
							prove this.
						</p>
					{:else}
						<!-- THE NEWEST RUN: ITS FACTS, WHAT WENT WRONG, AND ITS SCREENSHOTS -->
						{#if latest}
							{@const r = resultStatus(latest.result)}
							<div
								class="flex flex-col gap-3 rounded-lg border border-line bg-raised p-3"
								data-testid="check-run"
							>
								<div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
									<Badge tone={r.tone}>{r.label}</Badge>
									<span class="text-xs text-muted">
										{ago(latest.createdAt)}{seconds(latest.durationMs)
											? `, ${seconds(latest.durationMs)}`
											: ''}
									</span>
									{#if closedStep(latest)}<span class="text-xs text-muted"
											>{closedStep(latest)}</span
										>{/if}
									{#if latest.ran}
										<span class="text-xs text-muted">
											on {latest.ran.repo ?? latest.ran.registration}{latest.ran.branch
												? ` (${latest.ran.branch})`
												: ''}
										</span>
									{/if}
								</div>
								{#if problem}<p class="text-sm text-danger" role="status">{problem}</p>{/if}
								{@render shots(picturesOf(latest.files), `${mc.key} ${mc.text}`, false)}
								{@render others(latest.files)}
							</div>
						{:else}
							<p class="text-sm text-muted">It has not run yet.</p>
						{/if}

						{#if env.canWrite && view.canRun}
							<div class="flex flex-wrap items-center gap-2" data-testid={`run-controls-${mc.key}`}>
								<Button
									loading={busy === mc.key}
									onclick={() => run(mc.key)}
									data-testid={`run-${mc.key}`}
								>
									<Play size={14} aria-hidden="true" /> Run check
								</Button>
							</div>
							{#if notice[mc.key]}
								<p class="text-sm text-warning" role="status" data-testid={`unavailable-${mc.key}`}>
									{notice[mc.key]}
								</p>
							{/if}
						{/if}

						<!-- EARLIER RUNS AND THE SCRIPT, BOTH FOLDED AWAY UNTIL SOMEONE WANTS THEM -->
						{#if c.runs.length > 1}
							<Fold label="Earlier runs" count={c.runs.length - 1}>
								<ul class="flex flex-col" data-testid="check-earlier-runs">
									{#each c.runs.slice(1) as r (r.id)}
										{@const rs = resultStatus(r.result)}
										<li
											class="flex flex-col gap-2 border-b border-line py-3 first:pt-0 last:border-b-0 last:pb-0"
											data-testid="check-earlier-run"
										>
											<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
												<Badge tone={rs.tone}>{rs.label}</Badge>
												<span class="text-xs text-muted">
													{ago(r.createdAt)}{seconds(r.durationMs)
														? `, ${seconds(r.durationMs)}`
														: ''}
												</span>
												{#if r.ran}
													<span class="text-xs text-muted">
														on {r.ran.repo ?? r.ran.registration}{r.ran.branch
															? ` (${r.ran.branch})`
															: ''}
													</span>
												{/if}
											</div>
											{@render shots(picturesOf(r.files), `${mc.key}, ${ago(r.createdAt)}`, true)}
											{@render others(r.files)}
										</li>
									{/each}
								</ul>
							</Fold>
						{/if}
						<Fold label="View the script">
							{#snippet aside()}
								<Button
									size="sm"
									variant="ghost"
									onclick={() => copyScript(mc.key, c.script)}
									aria-label={`Copy the script of ${mc.key}`}
								>
									{#if copied === mc.key}
										<Check size={14} aria-hidden="true" /> Copied
									{:else}
										<Copy size={14} aria-hidden="true" /> Copy
									{/if}
								</Button>
							{/snippet}
							<pre
								class="max-h-72 overflow-auto rounded-lg border border-line bg-raised p-3 font-mono text-xs whitespace-pre-wrap"
								data-testid={`script-${mc.key}`}>{c.script}</pre>
						</Fold>
					{/if}
				</div>
			</TabCard>
		{/each}
	{/if}
</div>

<!-- A SCREENSHOT AT FULL SIZE. ALWAYS MOUNTED WITH open, SO IT CLOSES WITH ITS TRANSITION -->
<ResponsiveModal
	open={zoomOpen}
	onclose={() => (zoomOpen = false)}
	title={gallery ? `Screenshot ${gallery.index + 1} of ${gallery.ids.length}` : ''}
	size="lg"
>
	{#if gallery && zoomId}
		<img
			src={image(zoomId)}
			alt={`Screenshot ${gallery.index + 1} of ${gallery.ids.length}: ${gallery.title}`}
			class="block h-auto w-full rounded-lg border border-line"
		/>
		<p class="mt-2 text-xs text-muted">{gallery.title}</p>
	{/if}
	{#snippet footer()}
		{#if gallery && zoomId}
			{#if gallery.ids.length > 1}
				<Button onclick={() => step(-1)} aria-label="Previous screenshot">
					<ChevronLeft size={16} aria-hidden="true" /> Previous
				</Button>
				<Button onclick={() => step(1)} aria-label="Next screenshot">
					Next <ChevronRight size={16} aria-hidden="true" />
				</Button>
			{/if}
			<Button href={image(zoomId)} target="_blank" rel="noopener">Open in a new tab</Button>
		{/if}
	{/snippet}
</ResponsiveModal>
