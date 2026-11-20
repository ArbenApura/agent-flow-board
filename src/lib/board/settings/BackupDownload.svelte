<script lang="ts">
	// IMPORTED TYPES
	import type { DownloadFile, DownloadProgress, SaveFolder } from '#lib/board/backups.js';
	// IMPORTED MODULES
	import { canPickFolder, downloadBackup, formatBytes, pickFolder } from '#lib/board/backups.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import Lock from '@lucide/svelte/icons/lock';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	// IMPORTED COMPONENTS
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';

	// -- TYPES -- //

	type Phase = 'prep' | 'run' | 'done' | 'error';
	type Entry = DownloadFile & { received: number; state: 'waiting' | 'run' | 'done' | 'error' };

	// -- REQUIRED PROPS -- //

	let { org }: { org: string } = $props();

	// -- CONSTANTS -- //

	// Speed is read over the last few seconds, so it follows the connection and does not drift on a long download
	const WINDOW_MS = 4000;

	// -- STATES -- //

	let open = $state(false);
	let phase = $state<Phase>('prep');
	let entries = $state<Entry[]>([]);
	let reason = $state('');
	// True when a copy was too large to gather in memory and the browser's own download took it
	let browserSaved = $state(false);
	let startedAt = $state(0);
	let now = $state(0);
	let samples = $state<{ at: number; bytes: number }[]>([]);
	let controller: AbortController | null = null;

	// -- REACTIVE STATES -- //

	const totalBytes = $derived(entries.reduce((sum, e) => sum + e.size, 0));
	const receivedBytes = $derived(entries.reduce((sum, e) => sum + e.received, 0));
	const percent = $derived(totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : 0);
	const many = $derived(entries.length > 1);
	const speed = $derived.by(() => {
		const first = samples[0];
		const last = samples[samples.length - 1];
		if (!first || !last || last.at - first.at < 400) return 0;
		// Measured up to now, so a stalled stream shows a falling speed and a growing time left
		return ((last.bytes - first.bytes) / (Math.max(now, last.at) - first.at)) * 1000;
	});
	const secondsLeft = $derived(speed > 0 ? Math.ceil((totalBytes - receivedBytes) / speed) : null);
	const elapsed = $derived(startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0);
	const title = $derived(
		phase === 'done'
			? many
				? 'Backups saved'
				: 'Backup saved'
			: phase === 'error'
				? 'Download failed'
				: phase === 'prep'
					? 'Preparing the download'
					: many
						? `Downloading ${entries.length} backups`
						: 'Downloading backup'
	);
	const sub = $derived(
		phase === 'done'
			? browserSaved
				? 'Your browser is saving the file. Its Downloads list shows the progress. The files stay encrypted.'
				: 'Check your Downloads folder. The files stay encrypted.'
			: phase === 'error'
				? 'The file was not saved.'
				: phase === 'prep'
					? 'The server is opening the stored copy.'
					: many
						? 'Encrypted copy, one file after another.'
						: 'Encrypted copy, one file.'
	);

	// -- FUNCTIONS -- //

	const clock = (s: number | null) =>
		s === null ? '...' : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;

	/** Opens the window and starts. Called by the page with the files the person chose. */
	export function start(files: DownloadFile[]) {
		controller?.abort();
		controller = new AbortController();
		entries = files.map((f, i) => ({ ...f, received: 0, state: i === 0 ? 'run' : 'waiting' }));
		reason = '';
		browserSaved = false;
		phase = 'prep';
		startedAt = Date.now();
		now = startedAt;
		samples = [];
		open = true;
		void run(controller.signal);
	}

	async function run(signal: AbortSignal) {
		// Several copies go into one folder the person picks, so none is held in memory. The picker must open straight from the
		// click, so it is the first thing that happens. Closing it is not a failure
		let folder: SaveFolder | null = null;
		if (entries.length > 1 && canPickFolder()) {
			try {
				folder = await pickFolder();
			} catch {
				if (!signal.aborted) open = false;
				return;
			}
			// Two copies of one day share a file name, and a folder would overwrite the first, so a repeat gets a number
			const used: string[] = [];
			for (const e of entries) {
				let n = e.name;
				for (let k = 2; used.includes(n); k += 1) n = e.name.replace(/\.afbbak$/, `-${k}.afbbak`);
				used.push(n);
				e.name = n;
			}
		}
		for (let i = 0; i < entries.length; i += 1) {
			const entry = entries[i];
			entry.state = 'run';
			try {
				const saved = await downloadBackup(`/${org}/settings/backups/${entry.id}/download`, {
					fallbackName: entry.name,
					signal,
					folder,
					// Only the first file can use the save window, because the browser needs the click to be fresh
					direct: i === 0 && entries.length === 1,
					onProgress: (p: DownloadProgress) => {
						phase = 'run';
						// The size the server sent is the truth, and the list's size is only a guess until then
						if (p.total) entry.size = p.total;
						entry.received = p.received;
						const at = Date.now();
						samples = [
							...samples.filter((s) => at - s.at <= WINDOW_MS),
							{ at, bytes: receivedBytes }
						];
					}
				});
				if (saved.browser) browserSaved = true;
				entry.received = entry.size;
				entry.state = 'done';
			} catch (e) {
				if (signal.aborted) return;
				entry.state = 'error';
				// The person closing the save window is not a failure
				if (e instanceof DOMException && e.name === 'AbortError') {
					open = false;
					return;
				}
				now = Date.now();
				// A dropped connection says where it dropped; a sentence from the server is kept as it is
				reason =
					e instanceof Error && e.message && !/failed to fetch|network|load failed/i.test(e.message)
						? e.message.replace(/\.?$/, '.')
						: `The connection dropped at ${Math.round(percent)}%. Nothing was saved.`;
				phase = 'error';
				return;
			}
		}
		now = Date.now();
		phase = 'done';
	}

	function cancel() {
		controller?.abort();
		open = false;
	}

	function retry() {
		start(entries.map(({ id, name, size }) => ({ id, name, size })));
	}

	// -- REACTIVE STATEMENTS -- //

	// A clock for the elapsed time while a download is running
	$effect(() => {
		if (!open || phase === 'done' || phase === 'error') return;
		const timer = setInterval(() => (now = Date.now()), 500);
		return () => clearInterval(timer);
	});
</script>

<!-- THE DOWNLOAD WINDOW: PREPARING, DOWNLOADING WITH LIVE NUMBERS, SAVED OR FAILED, ONE BAR PER FILE WHEN SEVERAL ARE CHOSEN -->
<ResponsiveModal
	{open}
	{title}
	size="md"
	dismissOnBackdrop={false}
	onclose={() => (phase === 'run' || phase === 'prep' ? cancel() : (open = false))}
>
	<div class="flex flex-col gap-4" data-testid="backup-download">
		<p class="text-sm text-muted">{sub}</p>

		<!-- THE WHOLE DOWNLOAD IN ONE NUMBER -->
		<div class="flex items-baseline justify-between gap-3 tabular-nums">
			<span class="text-xl font-semibold" data-testid="backup-download-percent"
				>{Math.round(percent)}%</span
			>
			<span class="text-xs text-muted"
				>{formatBytes(receivedBytes)} of {formatBytes(totalBytes)}</span
			>
		</div>
		<div
			class="h-1.5 overflow-hidden rounded-full bg-raised"
			role="progressbar"
			aria-label="Download progress"
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={Math.round(percent)}
		>
			<!-- THE FILL WIDTH IS A RUNTIME PERCENT -->
			<div
				class={cn(
					'h-full rounded-full transition-[width] duration-200 ease-linear motion-reduce:transition-none',
					phase === 'done' ? 'bg-success' : phase === 'error' ? 'bg-danger' : 'bg-accent'
				)}
				style="width: {percent}%"
			></div>
		</div>

		<!-- THREE NUMBERS A PERSON WANTS -->
		<dl class="grid grid-cols-3 gap-2 rounded-lg bg-raised p-3">
			<div class="flex min-w-0 flex-col">
				<dt class="order-2 text-xs text-muted">Speed</dt>
				<dd class="text-sm font-semibold tabular-nums">
					{speed ? `${formatBytes(speed)}/s` : '–'}
				</dd>
			</div>
			<div class="flex min-w-0 flex-col">
				<dt class="order-2 text-xs text-muted">Time left</dt>
				<dd class="text-sm font-semibold tabular-nums">
					{phase === 'prep' ? 'Preparing' : phase === 'done' ? 'Done' : clock(secondsLeft)}
				</dd>
			</div>
			<div class="flex min-w-0 flex-col">
				<dt class="order-2 text-xs text-muted">Elapsed</dt>
				<dd class="text-sm font-semibold tabular-nums">{elapsed} s</dd>
			</div>
		</dl>

		<!-- ONE ROW PER FILE WHEN SEVERAL ARE DOWNLOADED -->
		{#if many}
			<ul class="overflow-hidden rounded-lg border border-line">
				{#each entries as e (e.id)}
					<li class="flex flex-col gap-1.5 border-b border-line px-3 py-2.5 last:border-b-0">
						<div class="flex items-center justify-between gap-3 text-sm">
							<span class="min-w-0 truncate font-mono text-xs font-medium">{e.name}</span>
							<span
								class={cn(
									'inline-flex shrink-0 items-center gap-1.5 text-xs tabular-nums',
									e.state === 'done'
										? 'text-success'
										: e.state === 'error'
											? 'text-danger'
											: 'text-muted'
								)}
							>
								{#if e.state === 'done'}<Check size={14} aria-hidden="true" />Saved
								{:else if e.state === 'error'}Failed
								{:else if e.state === 'waiting'}Waiting
								{:else}{e.size ? Math.round((e.received / e.size) * 100) : 0}%{/if}
							</span>
						</div>
						<div class="h-1.5 overflow-hidden rounded-full bg-raised">
							<!-- THE FILL WIDTH IS A RUNTIME PERCENT -->
							<div
								class={cn(
									'h-full rounded-full transition-[width] duration-200 ease-linear motion-reduce:transition-none',
									e.state === 'done'
										? 'bg-success'
										: e.state === 'error'
											? 'bg-danger'
											: 'bg-accent'
								)}
								style="width: {e.size ? Math.min(100, (e.received / e.size) * 100) : 0}%"
							></div>
						</div>
					</li>
				{/each}
			</ul>
		{/if}

		<!-- THE ENCRYPTION NOTE, OR WHY IT FAILED -->
		{#if phase === 'error'}
			<div
				role="alert"
				class="flex items-start gap-3 rounded-lg bg-danger-soft p-3 text-sm text-danger"
			>
				<TriangleAlert size={18} class="mt-px shrink-0" aria-hidden="true" />
				<span class="min-w-0 flex-1">{reason} Try again to start from the beginning.</span>
			</div>
		{:else}
			<div class="flex items-start gap-3 rounded-lg bg-info-soft p-3 text-xs text-info">
				<Lock size={16} class="mt-px shrink-0" aria-hidden="true" />
				<span class="min-w-0 flex-1"
					>The file is encrypted with this server's backup key. Keep it somewhere safe.</span
				>
			</div>
		{/if}
	</div>

	{#snippet footer()}
		{#if phase === 'prep' || phase === 'run'}
			<Button onclick={cancel}>Cancel download</Button>
		{:else}
			<Button onclick={() => (open = false)}>Close</Button>
		{/if}
		{#if phase === 'error'}
			<Button variant="primary" onclick={retry}>Try again</Button>
		{/if}
	{/snippet}
</ResponsiveModal>
