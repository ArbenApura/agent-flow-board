<script lang="ts">
	// IMPORTED TYPES
	import type { orgBackups } from '#lib/server/ops/settings.js';
	// IMPORTED MODULES
	import { deserialize } from '$app/forms';
	import { invalidate, invalidateAll } from '$app/navigation';
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { createFollower } from '#lib/settings/follow.js';
	import {
		formatBytes,
		groupRuns,
		newestGoodId,
		shortId,
		whenShort,
		whenText
	} from '#lib/board/backups.js';
	import { ago } from '#lib/board/status.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import DatabaseBackup from '@lucide/svelte/icons/database-backup';
	import Download from '@lucide/svelte/icons/download';
	import Lock from '@lucide/svelte/icons/lock';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	// IMPORTED COMPONENTS
	import BackupDownload from '#lib/board/settings/BackupDownload.svelte';
	import Section from '#lib/settings/Section.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Switch from '#lib/ui/Switch.svelte';

	// -- TYPES -- //

	type Backups = Awaited<ReturnType<typeof orgBackups>>;
	type Filter = 'all' | 'good' | 'failed';
	/** What the delete window is about. It keeps its text while the window closes. */
	type Pending = {
		ids: string[];
		title: string;
		text: string;
		when: string;
		size: string;
		/** The warning when the newest good copy is among those going, or null. */
		warn: string | null;
	};

	// -- REQUIRED PROPS -- //

	let {
		backups,
		org,
		group = 'Delivery'
	}: {
		/** What orgBackups returns, or null while a person who cannot manage backups has none. */
		backups: Backups | null;
		/** The organisation address, for the download address. */
		org: string;
		group?: string;
	} = $props();

	// -- STATES -- //

	let filter = $state<Filter>('all');
	let picked = $state<string[]>([]);
	let opened = $state<string[]>([]);
	let pending = $state<Pending | null>(null);
	let confirmOpen = $state(false);
	let deleting = $state(false);
	// The nightly switch: what the person set, and how its own save went
	let auto = $state(true);
	let savingAuto = $state(false);
	let savedAuto = $state(false);
	let autoError = $state('');
	let downloader = $state<{
		start: (files: { id: string; name: string; size: number }[]) => void;
	}>();

	// -- REACTIVE STATES -- //

	const runs = $derived(backups?.runs ?? []);
	const rows = $derived(groupRuns(runs));
	const goodCount = $derived(runs.filter((r) => r.state === 'done').length);
	const failedCount = $derived(runs.length - goodCount);
	const shown = $derived(
		rows.filter((r) => filter === 'all' || (filter === 'good') === (r.kind === 'good'))
	);
	const biggest = $derived(Math.max(1, ...runs.map((r) => r.size ?? 0)));
	const newestId = $derived(newestGoodId(runs));
	// A server with no run yet is not unhealthy, it is waiting for its first night
	const empty = $derived(runs.length === 0);
	const lastGoodText = $derived.by(() => {
		const at = health?.lastOkAt;
		if (!at) return 'No copy has finished yet.';
		const age = ago(at);
		// ago() turns into a date after two weeks, which does not read as an age
		return age.endsWith(' ago')
			? `Your last good copy is ${age.slice(0, -4)} old.`
			: `Your last good copy is from ${when(at)}.`;
	});
	const health = $derived(backups?.health);
	const options = $derived([
		{ value: 'all', label: 'All', count: runs.length },
		{ value: 'good', label: 'Good', count: goodCount },
		{ value: 'failed', label: 'Failed', count: failedCount }
	]);
	const pickedRuns = $derived(runs.filter((r) => picked.includes(r.id)));
	// A missing value means on. Paused follows the saved value, never an unsaved tick of the switch
	const autoSaved = $derived(backups?.autoBackups ?? true);
	const paused = $derived(!autoSaved);
	const autoDirty = $derived(auto !== autoSaved);

	// -- FUNCTIONS -- //

	const when = (v: string | Date) => whenText(v);

	// The switch follows the saved value whenever the page data is replaced, and keeps an unsaved tick otherwise
	const follow = createFollower();

	/** Saves the nightly switch through the same settings call as the other organisation limits. */
	async function saveAuto() {
		savingAuto = true;
		savedAuto = false;
		autoError = '';
		try {
			await api(org, '/settings', { method: 'PATCH', body: { autoBackups: auto }, key: newKey() });
		} catch (e) {
			autoError = e instanceof ApiError ? e.message : 'That was not saved.';
			savingAuto = false;
			return;
		}
		toast.success(auto ? 'Nightly backups are on.' : 'Nightly backups are paused.');
		await invalidateAll().catch(() => undefined);
		savingAuto = false;
		savedAuto = true;
	}

	function pick(id: string, on: boolean) {
		picked = on ? [...picked, id] : picked.filter((p) => p !== id);
	}

	function fold(key: string) {
		opened = opened.includes(key) ? opened.filter((k) => k !== key) : [...opened, key];
	}

	function fileName(run: { id: string; createdAt: string | Date }) {
		return `afb-${org}-${new Date(run.createdAt).toISOString().slice(0, 10)}.afbbak`;
	}

	function download(ids: string[]) {
		const files = runs
			.filter((r) => ids.includes(r.id) && r.state === 'done' && r.hasFile)
			.map((r) => ({ id: r.id, name: fileName(r), size: r.size ?? 0 }));
		if (files.length) downloader?.start(files);
	}

	/** Opens the delete window for backups of any kind, naming what goes. */
	function askDelete(ids: string[]) {
		const chosen = runs.filter((r) => ids.includes(r.id));
		const good = chosen.filter((r) => r.state === 'done');
		const many = chosen.length > 1;
		const hasNewest = newestId !== null && ids.includes(newestId);
		const next = runs.find((r) => r.state === 'done' && !ids.includes(r.id));
		pending = {
			ids,
			title: good.length
				? many
					? `Delete ${chosen.length} backups?`
					: 'Delete this backup?'
				: many
					? `Delete ${chosen.length} failed runs?`
					: 'Delete this failed run?',
			text: good.length
				? 'The encrypted copy is removed from storage. This cannot be undone.'
				: 'Only the record is removed. There is no stored copy of a failed run. This cannot be undone.',
			when: many ? `${chosen.length} runs` : when(chosen[0]?.createdAt ?? ''),
			size: good.length ? formatBytes(good.reduce((n, r) => n + (r.size ?? 0), 0)) : 'None',
			warn: hasNewest
				? `${many ? 'This includes your newest good backup.' : 'This is your newest good backup.'} ${
						next
							? `The next newest is from ${whenShort(next.createdAt)}.`
							: 'No good copy will be left.'
					}`
				: null
		};
		confirmOpen = true;
	}

	async function confirmDelete() {
		if (!pending || deleting) return;
		deleting = true;
		const body = new FormData();
		for (const id of pending.ids) body.append('id', id);
		try {
			const res = await fetch('?/deleteBackups', { method: 'POST', body });
			const result = deserialize(await res.text());
			if (result.type === 'success') {
				const data = result.data as { backupsDeleted: number; backupsFailed: number };
				picked = picked.filter((p) => !pending!.ids.includes(p));
				confirmOpen = false;
				// The delete is done, so a refresh that fails must not read as a failed delete
				await invalidate('afb:settings').catch(() => undefined);
				if (data.backupsFailed)
					toast.warning(
						`${data.backupsDeleted} deleted. ${data.backupsFailed} could not be removed from storage and are still listed.`
					);
				else toast.success(data.backupsDeleted === 1 ? 'Backup deleted.' : 'Backups deleted.');
			} else {
				const message =
					result.type === 'failure' && typeof result.data?.message === 'string'
						? result.data.message
						: 'The backups could not be deleted.';
				toast.error(message);
			}
		} catch {
			toast.error('The backups could not be deleted. Check your connection and try again.');
		} finally {
			deleting = false;
		}
	}

	// -- REACTIVE STATEMENTS -- //

	$effect(() => {
		follow('auto', autoSaved, (v) => (auto = v));
	});

	// A run that was deleted, here or somewhere else, leaves the selection
	$effect(() => {
		const ids = new Set(runs.map((r) => r.id));
		if (picked.some((p) => !ids.has(p))) picked = picked.filter((p) => ids.has(p));
	});
</script>

<!-- THE BACKUPS SECTION: A SUMMARY BAND, THEN A HISTORY THAT AN ADMIN CAN FILTER, DOWNLOAD FROM AND DELETE FROM -->
<Section
	id="backups"
	icon={DatabaseBackup}
	{group}
	title="Backups"
	text="A nightly encrypted copy of this organisation, kept apart from the app."
	dirty={autoDirty}
	saving={savingAuto}
	saved={savedAuto}
	error={autoError}
	onsave={backups?.enabled ? saveAuto : undefined}
>
	{#if !backups?.enabled}
		<div class="text-sm text-muted" data-testid="backups-off">
			Backups are not set up on this server. An operator turns them on with a backup key.
		</div>
	{:else}
		<!-- THE NIGHTLY SWITCH: OFF PAUSES THE AUTOMATIC COPY OF THIS ORGANISATION, THE COPIES ALREADY KEPT STAY -->
		<Switch
			label="Take a backup every night"
			hint="Turn this off to pause the nightly copy. Copies you already have stay, and you can still download or delete them."
			bind:checked={auto}
			data-testid="backups-auto"
		/>

		<!-- THE SERVER'S OWN WORDS WHEN SOMETHING IS WRONG, ONCE, ABOVE THE BAND -->
		{#if health && !health.ok && health.message && !empty}
			<Notice tone="danger" data-testid="backups-alert">{health.message}</Notice>
		{/if}

		<!-- SUMMARY BAND: STATUS, LAST GOOD COPY, WHAT IS STORED, HOW LONG COPIES ARE KEPT -->
		<!-- THE CELLS SIT ON A 1 PX GAP OVER THE LINE COLOUR, SO THE DIVIDERS STAY RIGHT AT EVERY COLUMN COUNT -->
		<dl
			class="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-4"
			data-testid="backups-status"
		>
			<div class="flex min-w-0 flex-col gap-1 bg-raised px-4 py-3">
				<dt class="order-1 text-xs text-muted">Status</dt>
				<dd class="order-2 flex min-h-7 items-center text-lg font-semibold">
					<Badge tone={paused ? 'neutral' : health?.ok || empty ? 'success' : 'danger'}
						>{paused ? 'Paused' : health?.ok || empty ? 'Healthy' : 'Needs attention'}</Badge
					>
				</dd>
				<dd class="order-3 text-xs text-muted">
					{#if paused}
						Nightly copies are off.
					{:else if empty}
						Waiting for the first copy.
					{:else if health?.ok}
						Copies are being taken as planned.
					{:else}
						{lastGoodText}
					{/if}
				</dd>
			</div>
			<div class="flex min-w-0 flex-col gap-1 bg-raised px-4 py-3">
				<dt class="order-1 text-xs text-muted">Last good backup</dt>
				<dd class="order-2 min-h-7 text-lg font-semibold tabular-nums">
					{#if health?.lastOkAt}
						<time datetime={new Date(health.lastOkAt).toISOString()} title={when(health.lastOkAt)}
							>{ago(health.lastOkAt)}</time
						>
					{:else}
						None yet
					{/if}
				</dd>
				<dd class="order-3 text-xs text-muted">
					{health?.lastOkAt ? when(health.lastOkAt) : 'Nothing has been copied.'}
				</dd>
			</div>
			<div class="flex min-w-0 flex-col gap-1 bg-raised px-4 py-3">
				<dt class="order-1 text-xs text-muted">Stored</dt>
				<dd class="order-2 min-h-7 text-lg font-semibold tabular-nums" data-testid="backups-stored">
					{formatBytes(backups.stored.bytes)}
				</dd>
				<dd class="order-3 text-xs text-muted">
					{backups.stored.copies} good {backups.stored.copies === 1 ? 'copy' : 'copies'} kept
				</dd>
			</div>
			<div class="flex min-w-0 flex-col gap-1 bg-raised px-4 py-3">
				<dt class="order-1 text-xs text-muted">Kept for</dt>
				<dd class="order-2 min-h-7 text-sm font-semibold">
					The newest {backups.retention.max}
				</dd>
				<dd class="order-3 text-xs text-muted">Older copies are removed by themselves.</dd>
			</div>
		</dl>

		<!-- THE ENCRYPTION NOTE, ONCE -->
		<div
			class={cn(
				'flex items-start gap-3 rounded-lg bg-info-soft p-3 text-xs text-info',
				empty && 'hidden'
			)}
		>
			<Lock size={16} class="mt-px shrink-0" aria-hidden="true" />
			<span class="min-w-0 flex-1"
				>Copies are encrypted with this server's backup key. A download is the encrypted file, and
				only an operator who holds the key can open it.</span
			>
		</div>

		{#if runs.length}
			<!-- HISTORY HEAD AND FILTER -->
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="flex flex-wrap items-baseline gap-x-3">
					<h3 class="text-sm font-semibold">History</h3>
					<span class="text-xs text-muted">The last 10 runs, newest first</span>
				</div>
				<SegmentedControl
					label="Show backups"
					{options}
					value={filter}
					onchange={(v) => {
						filter = v as Filter;
						// A tick the person can no longer see must not be acted on by Delete
						picked = [];
					}}
				/>
			</div>

			<!-- SELECTION BAR: ONLY WHILE SOMETHING IS TICKED -->
			{#if picked.length}
				<div
					role="region"
					aria-label="Selected backups"
					data-testid="backups-selection"
					class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-accent/35 bg-accent-soft px-3 py-2 text-sm font-medium text-accent-text"
				>
					<span>{picked.length} selected</span>
					<span class="flex-1"></span>
					{#if backups.canDownload && pickedRuns.some((r) => r.hasFile)}
						<Button size="sm" onclick={() => download(picked)}>
							<Download size={16} aria-hidden="true" />Download
						</Button>
					{/if}
					<Button size="sm" tone="danger" onclick={() => askDelete(picked)}>
						<Trash2 size={16} aria-hidden="true" />Delete
					</Button>
					<Button size="sm" onclick={() => (picked = [])}>Clear</Button>
				</div>
			{/if}

			<!-- THE HISTORY: A GOOD COPY IS ONE ROW, RUNS OF THE SAME FAILURE FOLD INTO ONE ROW -->
			<ul class="overflow-hidden rounded-lg border border-line" data-testid="backups-history">
				{#each shown as row (row.key)}
					{#if row.kind === 'good'}
						{@const r = row.run}
						<li
							data-row
							data-testid="backup-row"
							class={cn(
								'flex min-h-15 flex-wrap items-center gap-3 border-b border-line px-3 py-2 text-sm transition-colors last:border-b-0 hover:bg-raised/60 motion-reduce:transition-none max-sm:min-h-16',
								picked.includes(r.id) && 'bg-accent-soft hover:bg-accent-soft'
							)}
						>
							<!-- THE TICK HAS A 44 PX TAP AREA AROUND THE 20 PX BOX -->
							<span class="relative inline-flex size-11 shrink-0 items-center justify-center">
								<input
									type="checkbox"
									aria-label={`Select the backup of ${when(r.createdAt)}`}
									checked={picked.includes(r.id)}
									onchange={(e) => pick(r.id, e.currentTarget.checked)}
									class="peer size-5 cursor-pointer appearance-none rounded-[5px] border-[1.5px] border-muted bg-surface checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
								/>
								<Check
									size={14}
									strokeWidth={3}
									class="pointer-events-none absolute text-accent-ink opacity-0 peer-checked:opacity-100"
									aria-hidden="true"
								/>
							</span>
							<span
								class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-success-soft text-success"
								aria-hidden="true"><Check size={16} /></span
							>
							<div class="min-w-40 flex-1">
								<span class="flex flex-wrap items-baseline gap-x-2.5 font-medium tabular-nums">
									{formatBytes(r.size)}
									<code class="font-mono text-xs font-normal text-muted">{shortId(r.id)}</code>
								</span>
								<span class="block text-xs text-muted">{when(r.createdAt)} &middot; encrypted</span>
								<!-- THE BAR IS THE SIZE OF THIS COPY AGAINST THE BIGGEST ONE, A RUNTIME PERCENT -->
								<span
									class="mt-1.5 block h-1 w-full max-w-48 overflow-hidden rounded-full bg-raised"
									><span
										class="fill-in block h-full rounded-full bg-accent"
										style="width: {Math.round(((r.size ?? 0) / biggest) * 100)}%"
									></span></span
								>
							</div>
							<div class="flex shrink-0 items-center gap-1">
								<time
									class="mr-2 text-xs text-muted tabular-nums"
									datetime={new Date(r.createdAt).toISOString()}
									title={when(r.createdAt)}>{ago(r.createdAt)}</time
								>
								{#if backups.canDownload && r.hasFile}
									<Button
										variant="subtle"
										size="sm"
										iconOnly
										aria-label={`Download the backup of ${when(r.createdAt)}`}
										title="Download"
										onclick={() => download([r.id])}><Download size={18} /></Button
									>
								{/if}
								<Button
									variant="subtle"
									size="sm"
									iconOnly
									tone="danger"
									aria-label={`Delete the backup of ${when(r.createdAt)}`}
									title="Delete"
									onclick={() => askDelete([r.id])}><Trash2 size={18} /></Button
								>
							</div>
						</li>
					{:else}
						{@const many = row.runs.length > 1}
						{@const first = row.runs[row.runs.length - 1]}
						{@const last = row.runs[0]}
						<li
							data-row
							data-testid="backup-failed-row"
							class="flex min-h-15 flex-wrap items-center gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0 hover:bg-raised/60 max-sm:min-h-16"
						>
							<span class="w-11 shrink-0 max-sm:hidden" aria-hidden="true"></span>
							<span
								class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-danger"
								aria-hidden="true"><X size={16} /></span
							>
							<div class="min-w-40 flex-1">
								<span class="block font-medium text-danger"
									>{many ? `${row.runs.length} runs failed` : 'Run failed'}</span
								>
								<span class="block text-xs text-muted"
									>{row.error}
									{many
										? `${whenShort(first.createdAt)} to ${whenShort(last.createdAt)}.`
										: `${when(last.createdAt)}.`}</span
								>
							</div>
							<div class="flex shrink-0 items-center gap-1">
								<time
									class="mr-2 text-xs text-muted tabular-nums"
									datetime={new Date(last.createdAt).toISOString()}
									title={when(last.createdAt)}>{ago(last.createdAt)}</time
								>
								{#if many}
									<Button
										size="sm"
										aria-expanded={opened.includes(row.key)}
										aria-controls={`runs-${row.key}`}
										onclick={() => fold(row.key)}
									>
										{opened.includes(row.key) ? 'Hide runs' : 'Show runs'}
										<ChevronDown
											size={16}
											aria-hidden="true"
											class={cn(
												'transition-transform duration-200 motion-reduce:transition-none',
												opened.includes(row.key) && 'rotate-180'
											)}
										/>
									</Button>
								{:else}
									<Button
										variant="subtle"
										size="sm"
										iconOnly
										tone="danger"
										aria-label={`Delete the failed run of ${when(last.createdAt)}`}
										title="Delete"
										onclick={() => askDelete([last.id])}><Trash2 size={18} /></Button
									>
								{/if}
							</div>
							<!-- THE FOLDED RUNS OPEN BY A ROW HEIGHT TRANSITION, SO NOTHING JUMPS -->
							{#if many}
								<div
									id={`runs-${row.key}`}
									class={cn(
										'grid w-full transition-[grid-template-rows] duration-250 ease-out motion-reduce:transition-none',
										opened.includes(row.key) ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
									)}
								>
									<div class="overflow-hidden" inert={!opened.includes(row.key)}>
										<ul class="mt-1 ml-4 border-l-2 border-line pl-3">
											{#each row.runs as f (f.id)}
												<li
													class="flex min-h-9 items-center justify-between gap-3 text-xs text-muted tabular-nums"
												>
													<span>{whenShort(f.createdAt)}</span>
													<Button
														variant="subtle"
														size="sm"
														iconOnly
														tone="danger"
														aria-label={`Delete the failed run of ${when(f.createdAt)}`}
														title="Delete this run"
														onclick={() => askDelete([f.id])}><Trash2 size={16} /></Button
													>
												</li>
											{/each}
											<li class="py-1">
												<Button
													size="sm"
													tone="danger"
													onclick={() => askDelete(row.runs.map((f) => f.id))}
													>Delete all {row.runs.length} failed runs</Button
												>
											</li>
										</ul>
									</div>
								</div>
							{/if}
						</li>
					{/if}
				{:else}
					<li class="px-3 py-6 text-center text-sm text-muted">Nothing matches this filter.</li>
				{/each}
			</ul>
		{:else}
			<!-- NO COPY YET -->
			<div
				class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-muted"
				data-testid="backups-empty"
			>
				<DatabaseBackup size={24} aria-hidden="true" />
				<span class="font-medium text-ink">No backup has run yet</span>
				<span
					>{paused
						? 'Nightly copies are off. Turn the switch on to take one every night.'
						: 'The first copy shows here after the next nightly run.'}</span
				>
			</div>
		{/if}
	{/if}
</Section>

<!-- THE DELETE WINDOW: NAMES WHAT GOES, SAYS WHEN IT IS THE NEWEST GOOD COPY AND THAT IT CANNOT BE UNDONE -->
<ResponsiveModal
	open={confirmOpen}
	title={pending?.title ?? 'Delete this backup?'}
	size="sm"
	busy={deleting}
	onclose={() => (confirmOpen = false)}
>
	<div class="flex flex-col gap-3" data-testid="backup-delete-dialog">
		<p class="text-muted">{pending?.text}</p>
		<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-raised p-3 text-sm">
			<dt class="text-muted">Taken</dt>
			<dd class="tabular-nums">{pending?.when}</dd>
			<dt class="text-muted">Size</dt>
			<dd class="tabular-nums">{pending?.size}</dd>
		</dl>
		{#if pending?.warn}
			<Notice tone="warning">
				{pending.warn}
			</Notice>
		{/if}
	</div>
	{#snippet footer()}
		<Button disabled={deleting} onclick={() => (confirmOpen = false)}>Cancel</Button>
		<Button
			variant="danger"
			loading={deleting}
			onclick={confirmDelete}
			data-testid="backup-delete-confirm"
			>{pending && pending.ids.length > 1 ? 'Delete backups' : 'Delete backup'}</Button
		>
	{/snippet}
</ResponsiveModal>

<!-- THE DOWNLOAD WINDOW -->
<BackupDownload bind:this={downloader} {org} />
