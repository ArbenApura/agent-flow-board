<script lang="ts">
	// IMPORTED TYPES
	import type { Device, Status } from './status';
	// IMPORTED CONSTANTS
	import {
		DEVICE_LABEL,
		KIND_LABEL,
		SEVERITY_LABEL,
		STATUS_LABEL,
		ago,
		retestPrompt
	} from './status';
	// IMPORTED DEP-COMPONENTS
	import Bug from '@lucide/svelte/icons/bug';
	import Check from '@lucide/svelte/icons/check';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import CircleHelp from '@lucide/svelte/icons/circle-question-mark';
	import CircleX from '@lucide/svelte/icons/circle-x';
	import Clock from '@lucide/svelte/icons/clock';
	import Copy from '@lucide/svelte/icons/copy';
	import ImageOff from '@lucide/svelte/icons/image-off';
	import Laptop from '@lucide/svelte/icons/laptop';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Maximize2 from '@lucide/svelte/icons/maximize-2';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Scan from '@lucide/svelte/icons/scan';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import Tablet from '@lucide/svelte/icons/tablet';
	import X from '@lucide/svelte/icons/x';
	// IMPORTED COMPONENTS
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import HistoryStrip from './HistoryStrip.svelte';
	import TestStatus from './TestStatus.svelte';

	// -- TYPES -- //

	type Result = {
		device: string;
		width: number;
		height: number;
		mode: string;
		status: string;
		reason: string;
		failedStep: number | null;
		actual: string;
		output: string;
		consoleLines: string[];
		severity: string | null;
		bugPriority: string | null;
		runNo: number;
		harness: string;
		commit: string;
		at: string;
		proofs: {
			id: string;
			step: number | null;
			gone: boolean;
			image: string | null;
			width: number;
			height: number;
		}[];
	};
	type Detail = {
		key: string;
		area: string;
		kind: string;
		title: string;
		priority: string;
		version: number;
		steps: { action: string }[];
		inputData: string;
		checks: { kind: string; expect: string }[];
		devices: { device: string; width: number; height: number }[];
		mode: string;
		status: string;
		results: Result[];
		history: { runNo: number; status: Status; version: number }[];
		plans: { ref: string; role: string }[];
		defects: { ref: string; title: string; status: string }[];
	};

	// -- REQUIRED PROPS -- //

	let {
		detail,
		onclose,
		base,
		oncopy
	}: {
		detail: Detail | null;
		onclose: () => void;
		/** The project address, for links to plans and tasks. */
		base: string;
		oncopy: (text: string) => void;
	} = $props();

	// -- CONSTANTS -- //

	const DEVICE_ICON = {
		wide: Monitor,
		laptop: Laptop,
		tablet: Tablet,
		phone: Smartphone,
		custom: Scan
	};
	const ROLE_TEXT: Record<string, string> = {
		new: 'wrote it',
		update: 'updated it',
		reuse: 're-ran it',
		retire: 'retired it'
	};
	const SECTION = 'text-xs font-semibold tracking-wider text-muted uppercase';

	// -- STATES -- //

	// The last case shown stays during the close transition, so the drawer never flashes empty
	let held = $state<Detail | null>(null);
	let proofDevice = $state<string | null>(null);
	let broken = $state<Record<string, boolean>>({});

	// -- REACTIVE STATES -- //

	const d = $derived(held);
	const open = $derived(detail !== null);
	// One row per device the case names, with its latest result when it has one
	const devices = $derived(
		d
			? (d.kind === 'ui' ? d.devices : [{ device: 'laptop', width: 1280, height: 800 }]).map(
					(spec) => ({
						spec,
						result:
							d.results.find((r) => r.device === spec.device && r.width === spec.width) ?? null
					})
				)
			: []
	);
	const failing = $derived(devices.find((x) => x.result?.status === 'fail') ?? null);
	const shownProof = $derived(
		devices.find((x) => `${x.spec.device}:${x.spec.width}` === proofDevice) ??
			failing ??
			devices.find((x) => x.result) ??
			devices[0] ??
			null
	);
	const name = (spec: { device: string; width: number; height: number }) =>
		spec.device === 'custom'
			? `${spec.width} × ${spec.height}`
			: DEVICE_LABEL[spec.device as Device];
	const failedAt = $derived(failing?.result?.failedStep ?? null);
	const shownResult = $derived(failing?.result ?? d?.results[0] ?? null);
	const consoleLines = $derived(d ? d.results.flatMap((r) => r.consoleLines) : []);
	const verdict = $derived.by(() => {
		if (!d) return null;
		const latest =
			d.results
				.map((r) => r.at)
				.sort()
				.at(-1) ?? null;
		if (d.status === 'fail' && failing?.result)
			return {
				tone: 'danger' as const,
				title: `Failed on ${name(failing.spec)}${failedAt ? ` at step ${failedAt} of ${d.steps.length}` : ''}`,
				line: [
					failing.result.severity ? `Severity ${SEVERITY_LABEL[failing.result.severity]}` : null,
					failing.result.bugPriority ? `Bug priority ${failing.result.bugPriority}` : null,
					`Run ${failing.result.runNo} · ${ago(failing.result.at)}`
				]
					.filter(Boolean)
					.join(' · ')
			};
		// A fail on a device whose size no longer matches the case (a new version changed it) still reads as a fail
		const anyFail = d.results.find((r) => r.status === 'fail');
		if (d.status === 'fail' && anyFail)
			return {
				tone: 'danger' as const,
				title: `Failed on ${anyFail.device}`,
				line: [
					anyFail.severity ? `Severity ${SEVERITY_LABEL[anyFail.severity]}` : null,
					`Run ${anyFail.runNo} · ${ago(anyFail.at)}`
				]
					.filter(Boolean)
					.join(' · ')
			};
		if (d.status === 'running')
			return {
				tone: 'neutral' as const,
				title: 'Running now',
				line: 'A run is on this case. Its result appears here as it comes in.'
			};
		if (d.status === 'blocked')
			return {
				tone: 'warning' as const,
				title: 'Blocked',
				line:
					d.results.find((r) => r.status === 'blocked')?.reason ||
					'The run could not reach this case.'
			};
		if (d.status !== 'pass' || d.results.length === 0)
			return {
				tone: 'neutral' as const,
				title: 'Not run yet',
				line: `It runs with the next plan that touches ${d.area}, or with a sweep.`
			};
		return {
			tone: 'success' as const,
			title: 'Passed on every device',
			line: `All checks met · ${latest ? ago(latest) : ''}`
		};
	});
	const TONE = {
		danger: ['border-danger/30 bg-danger-soft', 'text-danger'],
		warning: ['border-warning/30 bg-warning-soft', 'text-warning'],
		success: ['border-success/30 bg-success-soft', 'text-success'],
		neutral: ['border-line bg-raised/60', 'text-muted']
	};

	// -- REACTIVE STATEMENTS -- //

	$effect(() => {
		if (detail) {
			held = detail;
			proofDevice = null;
		}
	});
</script>

<!-- THE CASE DRAWER: THE DRAWER VARIANT OF RESPONSIVEMODAL, A BOTTOM SHEET ON A PHONE (AFB-20261127-0438) -->
<ResponsiveModal {open} {onclose} title={d?.title ?? 'Test case'} variant="drawer">
	{#snippet heading()}
		<span class="flex min-w-0 flex-col">
			<span class="font-mono text-xs font-normal text-muted">{d?.key}</span>
			<span class="line-clamp-2">{d?.title}</span>
		</span>
	{/snippet}
	{#if d && verdict}
		<div class="flex flex-col gap-5" data-testid="case-drawer">
			<!-- THE VERDICT: WHAT HAPPENED, WHERE AND HOW BAD -->
			<div class={['flex items-start gap-3 rounded-xl border p-4', TONE[verdict.tone][0]]}>
				<span class={['mt-0.5 shrink-0', TONE[verdict.tone][1]]}>
					{#if verdict.tone === 'danger'}<CircleX
							size={18}
							aria-hidden="true"
						/>{:else if verdict.tone === 'success'}<CircleCheck
							size={18}
							aria-hidden="true"
						/>{:else}<Clock size={18} aria-hidden="true" />{/if}
				</span>
				<div class="min-w-0">
					<p class="text-base font-semibold text-ink">{verdict.title}</p>
					<p class="mt-0.5 text-sm text-muted">{verdict.line}</p>
				</div>
			</div>

			<!-- DEVICES: ONE ROW EACH -->
			<section class="flex flex-col gap-2">
				<h3 class={SECTION}>Devices</h3>
				<ul class="divide-y divide-line rounded-lg border border-line">
					{#each devices as x (`${x.spec.device}:${x.spec.width}`)}
						{@const Icon = DEVICE_ICON[x.spec.device as keyof typeof DEVICE_ICON] ?? Scan}
						<li class="flex min-h-11 items-center gap-3 px-3">
							<Icon size={16} class="text-muted" aria-hidden="true" />
							<span class="w-16 text-sm font-medium text-ink">{name(x.spec)}</span>
							<span class="font-mono text-xs whitespace-nowrap text-muted"
								>{x.spec.width} × {x.spec.height}</span
							>
							<span class="ml-auto"
								><TestStatus status={(x.result?.status ?? 'not_run') as Status} /></span
							>
						</li>
					{/each}
				</ul>
			</section>

			<!-- DETAILS AS A LIST OF LABEL AND VALUE -->
			<section class="flex flex-col gap-2">
				<h3 class={SECTION}>Details</h3>
				<dl
					class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 rounded-lg bg-raised/60 p-4 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]"
				>
					<dt class="text-muted">Area</dt>
					<dd
						class="min-w-0 truncate font-mono text-xs leading-5 whitespace-nowrap text-ink sm:col-span-3"
					>
						{d.area.split('/').join(' / ')}
					</dd>
					<dt class="text-muted">Kind</dt>
					<dd class="text-ink">{KIND_LABEL[d.kind] ?? d.kind}</dd>
					<dt class="text-muted">Priority</dt>
					<dd class="text-ink capitalize">{d.priority}</dd>
					<dt class="text-muted">Version</dt>
					<dd class="text-ink">v{d.version}</dd>
					<dt class="text-muted">Mode</dt>
					<dd class="text-ink capitalize">{d.mode}</dd>
					{#if d.results[0]}
						<dt class="text-muted">Tested by</dt>
						<dd class="truncate text-ink">{d.results[0].harness || '—'}</dd>
						<dt class="text-muted">Commit</dt>
						<dd class="font-mono text-xs leading-5 text-ink">
							{d.results[0].commit ? d.results[0].commit.slice(0, 7) : '—'}
						</dd>
					{/if}
				</dl>
			</section>

			<!-- STEPS, THE FAILED ONE MARKED WITH THE DEVICE IT FAILED ON -->
			<section class="flex flex-col gap-2">
				<h3 class={SECTION}>Steps</h3>
				<ol class="flex flex-col">
					{#each d.steps as s, i (i)}
						{@const n = i + 1}
						{@const state =
							failedAt === null
								? d.status === 'pass'
									? 'pass'
									: 'open'
								: n < failedAt
									? 'pass'
									: n === failedAt
										? 'fail'
										: 'open'}
						<li class="relative flex gap-3 pb-3 last:pb-0">
							{#if i < d.steps.length - 1}<span
									class="absolute top-7 bottom-1 left-3 w-px bg-line"
									aria-hidden="true"
								></span>{/if}
							{#if state === 'pass'}
								<span
									class="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-success-soft text-success"
									><Check size={14} aria-hidden="true" /></span
								>
							{:else if state === 'fail'}
								<span
									class="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger"
									><X size={14} aria-hidden="true" /></span
								>
							{:else}
								<span
									class="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-xs font-semibold text-muted tabular-nums"
									>{n}</span
								>
							{/if}
							<span class="flex min-w-0 flex-col pt-0.5">
								<span class={['text-sm', state === 'open' ? 'text-muted' : 'text-ink']}
									>{s.action}</span
								>
								{#if state === 'fail' && failing}
									<span class="mt-1 text-xs font-medium text-danger"
										>Failed here, on {name(failing.spec)}</span
									>
								{/if}
							</span>
						</li>
					{/each}
				</ol>
			</section>

			{#if d.inputData}
				<section class="flex flex-col gap-2">
					<h3 class={SECTION}>Input data</h3>
					<pre
						class="overflow-x-auto rounded-lg bg-raised p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-ink">{d.inputData}</pre>
				</section>
			{/if}

			<!-- EXPECTED BESIDE ACTUAL -->
			<section class="flex flex-col gap-2">
				<h3 class={SECTION}>Expected and actual</h3>
				<div class="grid gap-3 sm:grid-cols-2">
					<div class="rounded-lg border border-line p-3">
						<p class="mb-1 text-xs font-medium text-muted">Expected</p>
						<ul>
							{#each d.checks as c, i (i)}
								<li class="flex items-start gap-2 py-1.5">
									<span class="mt-0.5 text-muted"><CircleHelp size={16} aria-hidden="true" /></span>
									<span class="min-w-0 flex-1"
										><span class="font-mono text-xs text-muted">{c.kind}</span>
										<span class="text-ink">{c.expect}</span></span
									>
								</li>
							{/each}
						</ul>
					</div>
					<div
						class={[
							'rounded-lg border p-3',
							d.status === 'fail' ? 'border-danger/40 bg-danger-soft/40' : 'border-line'
						]}
					>
						<p class="mb-1 text-xs font-medium text-muted">Actual</p>
						{#if shownResult && (shownResult.actual || shownResult.output)}
							<p class="text-sm whitespace-pre-wrap text-ink">
								{shownResult.actual || shownResult.output}
							</p>
						{:else}
							<p class="text-sm text-muted">No result yet.</p>
						{/if}
					</div>
				</div>
			</section>

			<!-- PROOF: ONE PICTURE PER DEVICE, A PASS HAS PICTURES TOO -->
			<section class="flex flex-col gap-2">
				<h3 class={SECTION}>Proof</h3>
				{#if d.kind === 'ui'}
					{#if devices.some((x) => x.result)}
						<div
							role="radiogroup"
							aria-label="Proof device"
							class="inline-flex h-10 w-fit shrink-0 items-stretch rounded-lg border border-line bg-raised p-0.5 max-sm:h-11"
						>
							{#each devices as x (`${x.spec.device}:${x.spec.width}`)}
								{@const Icon = DEVICE_ICON[x.spec.device as keyof typeof DEVICE_ICON] ?? Scan}
								{@const on = shownProof === x}
								<button
									type="button"
									role="radio"
									aria-checked={on}
									onclick={() => (proofDevice = `${x.spec.device}:${x.spec.width}`)}
									class={[
										'inline-flex h-full min-w-11 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
										on
											? 'bg-surface text-ink shadow-[0_0_0_1px_var(--line)]'
											: 'text-muted hover:text-ink'
									]}
								>
									<Icon size={16} class="shrink-0" aria-hidden="true" />
									<span class="max-sm:sr-only">{name(x.spec)}</span>
								</button>
							{/each}
						</div>
						{@const r = shownProof?.result ?? null}
						{@const pic = r?.proofs.find((p) => p.step === r.failedStep) ?? r?.proofs[0] ?? null}
						{#if r && pic && pic.image && !pic.gone && !broken[pic.id]}
							<figure class="flex flex-col gap-2 rounded-lg bg-raised/60 p-3">
								<img
									src={pic.image}
									alt={`${name(shownProof!.spec)} screenshot of ${d.key}${pic.step ? ` at step ${pic.step}` : ''}`}
									class="mx-auto max-h-[480px] w-auto rounded-lg border border-line bg-bg"
									loading="lazy"
									onerror={() => (broken[pic.id] = true)}
								/>
								<figcaption
									class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted"
								>
									<span
										>{name(shownProof!.spec)} · {r.width} × {r.height} · {r.mode} · {pic.step
											? `step ${pic.step}`
											: 'end state'} · {ago(r.at)}</span
									>
									<a
										href={pic.image}
										target="_blank"
										rel="noopener"
										class="inline-flex min-h-8 cursor-pointer items-center gap-1 text-sm text-accent-text hover:underline max-sm:min-h-11"
									>
										<Maximize2 size={14} aria-hidden="true" /> Open full size
									</a>
								</figcaption>
							</figure>
						{:else if r && pic}
							<p
								class="flex items-center gap-2 rounded-lg border border-line bg-raised/60 p-3 text-sm text-muted"
							>
								<ImageOff size={16} aria-hidden="true" /> Picture removed after 10 newer runs.
							</p>
						{:else if r?.status === 'running'}
							<p class="flex items-center gap-2 text-sm text-muted">
								<LoaderCircle size={16} class="motion-safe:animate-spin" aria-hidden="true" /> The picture
								is taken when this device finishes.
							</p>
						{:else}
							<p class="text-sm text-muted">No picture for this device yet.</p>
						{/if}
					{:else}
						<p class="text-sm text-muted">
							No pictures yet. Each device gets one when the case runs.
						</p>
					{/if}
				{:else}
					{@const r = d.results[0] ?? null}
					{#if r?.output}
						<pre
							class="overflow-x-auto rounded-lg bg-raised p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-ink">{r.output}</pre>
					{:else}
						<p class="text-sm text-muted">The check output shows here once the case runs.</p>
					{/if}
				{/if}
			</section>

			<!-- CONSOLE AND NETWORK -->
			<section class="flex flex-col gap-2">
				<h3 class={SECTION}>Console and network</h3>
				{#if consoleLines.length > 0}
					<ul class="flex flex-col gap-1 rounded-lg bg-raised p-3 font-mono text-xs text-ink">
						{#each consoleLines.slice(0, 20) as l, i (i)}<li class="break-all">{l}</li>{/each}
					</ul>
				{:else if d.results.length > 0}
					<p class="flex items-center gap-2 text-sm text-ink">
						<span class="text-success"><CircleCheck size={16} aria-hidden="true" /></span>No console
						errors · no failed requests
					</p>
				{:else}
					<p class="text-sm text-muted">Read when the case runs.</p>
				{/if}
			</section>

			<section class="flex flex-col gap-2">
				<h3 class={SECTION}>Last 10 runs</h3>
				<HistoryStrip history={d.history} large />
				<p class="text-xs text-muted">
					{d.history.length === 0
						? 'No runs yet.'
						: `${d.history.filter((h) => h.status === 'pass').length} of ${d.history.length} passed. ${STATUS_LABEL[d.history.at(-1)!.status]} last time.`}
				</p>
			</section>

			{#if d.plans.length > 0}
				<section class="flex flex-col gap-2">
					<h3 class={SECTION}>Plans</h3>
					<ul class="flex flex-col gap-1">
						{#each d.plans as p (`${p.ref}:${p.role}`)}
							<li class="flex flex-wrap items-center gap-2 text-sm">
								<a
									href={`${base}/${p.ref}?tab=testing`}
									class="inline-flex min-h-8 cursor-pointer items-center font-mono text-xs text-accent-text hover:underline max-sm:min-h-11"
									>{p.ref}</a
								>
								<span class="text-muted">{ROLE_TEXT[p.role] ?? p.role}</span>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			{#if d.defects.length > 0}
				<section class="flex flex-col gap-2">
					<h3 class={SECTION}>Defect</h3>
					{#each d.defects as t (t.ref)}
						<a
							href={`${base}/tasks?task=${t.ref}`}
							class="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line px-3 py-2 hover:bg-raised"
						>
							<Bug size={16} class="text-danger" aria-hidden="true" />
							<span class="font-mono text-xs text-muted">{t.ref}</span>
							<span class="min-w-0 flex-1 text-sm text-ink">{t.title}</span>
							<span class="rounded-full bg-raised px-2.5 py-0.5 text-badge font-semibold text-ink"
								>{t.status === 'DONE' ? 'Fixed' : 'Open'}</span
							>
						</a>
					{/each}
					<p class="text-xs text-muted">
						Filed by the run. It closes when a plan that adopted this case passes it on every
						device.
					</p>
				</section>
			{/if}
		</div>
	{/if}
	{#snippet footer()}
		<Button size="sm" class="max-sm:flex-1" onclick={() => d && oncopy(retestPrompt(d.key))}>
			<Copy size={16} aria-hidden="true" /> Copy retest command
		</Button>
	{/snippet}
</ResponsiveModal>
