<script lang="ts">
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import { renderMarkdown } from '#lib/markdown.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';

	// -- TYPES -- //

	type Version = {
		number: number;
		title: string;
		cause: 'typing' | 'agent' | 'api' | 'restore';
		createdAt: string;
		author: string | null;
		size: number;
	};
	type Full = { number: number; title: string; body: string; untrusted: boolean };

	// -- CONSTANTS -- //

	/** Why a version was kept, in the words a person understands. */
	const CAUSE: Record<Version['cause'], string> = {
		typing: 'Saved while typing',
		agent: 'Before an agent changed it',
		api: 'Before a program changed it',
		restore: 'Before a restore'
	};

	// -- REQUIRED PROPS -- //

	let {
		open,
		onclose,
		org,
		project,
		note,
		canWrite,
		onrestore
	}: {
		open: boolean;
		onclose: () => void;
		org: string;
		/** The project key. */
		project: string;
		/** The note reference, for example N-12. */
		note: string;
		canWrite: boolean;
		/** Called after a restore, so the page reads the note again. */
		onrestore: () => Promise<void>;
	} = $props();

	// -- STATES -- //

	let versions = $state<Version[] | null>(null);
	let failed = $state(false);
	let viewing = $state<Full | null>(null);
	let loadingNumber = $state<number | null>(null);
	let busy = $state<number | null>(null);

	// -- REACTIVE STATES -- //

	const base = $derived(`/projects/${project}/notes/${note}/versions`);
	const html = $derived(
		viewing
			? renderMarkdown(viewing.body, {
					untrusted: viewing.untrusted,
					mode: 'note',
					linkBase: { org, project }
				})
			: ''
	);

	// -- FUNCTIONS -- //

	async function load() {
		failed = false;
		try {
			const res = await api<{ versions: Version[] }>(org, base);
			versions = res.versions;
		} catch {
			failed = true;
		}
	}

	async function preview(n: number) {
		loadingNumber = n;
		try {
			viewing = await api<Full>(org, `${base}/${n}`);
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'That version could not be read.');
		} finally {
			loadingNumber = null;
		}
	}

	async function restore(n: number) {
		busy = n;
		try {
			await api(org, `${base}/${n}/restore`, { method: 'POST', body: {}, key: newKey() });
			toast.success('The earlier version is the newest one now.');
			viewing = null;
			await onrestore();
			await load();
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The version could not be restored.');
		} finally {
			busy = null;
		}
	}

	// -- REACTIVE STATEMENTS -- //

	// Every opening reads the list again, so a version kept a moment ago is there
	$effect(() => {
		if (open) {
			viewing = null;
			void load();
		}
	});
</script>

<!-- HISTORY: THE EARLIER TEXTS OF THE NOTE, NEWEST FIRST. PREVIEW SHOWS ONE, RESTORE COPIES IT ON TOP AS THE NEWEST. NOTHING IS EVER DELETED -->
<ResponsiveModal {open} {onclose} title="History" variant="drawer" busy={busy !== null}>
	{#if viewing}
		{@const shown = viewing}
		<div class="flex flex-col gap-3" data-testid="note-version-preview">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<p class="min-w-0 text-sm font-medium break-words text-ink">
					Version {shown.number}: {shown.title}
				</p>
				<span class="flex items-center gap-2">
					<Button size="sm" onclick={() => (viewing = null)}>Back to the list</Button>
					{#if canWrite}
						<Button size="sm" loading={busy === shown.number} onclick={() => restore(shown.number)}
							>Restore</Button
						>
					{/if}
				</span>
			</div>
			<div class="rounded-xl border border-line bg-surface p-4">
				{#if shown.body === ''}
					<p class="text-sm text-muted">This version has no text.</p>
				{:else}
					<div class="md flex flex-col gap-2 text-sm text-ink">
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown -->
						{@html html}
					</div>
				{/if}
			</div>
		</div>
	{:else}
		<p class="mb-3 text-sm text-muted">
			Restore copies an earlier text on top as the newest one. The text you have now is kept first,
			so nothing is lost.
		</p>
		{#if failed}
			<p class="text-sm text-danger" role="alert">
				The history could not be read.
				<button type="button" class="cursor-pointer text-accent-text underline" onclick={load}
					>Try again</button
				>
			</p>
		{:else if versions === null}
			<Skeleton variant="row" lines={4} />
		{:else if versions.length === 0}
			<p class="text-sm text-muted" data-testid="note-history-empty">No earlier versions</p>
		{:else}
			<ul class="rounded-xl border border-line bg-surface" data-testid="note-history">
				{#each versions as v (v.number)}
					<li
						class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3.5 py-3 last:border-b-0"
						data-testid="note-version"
					>
						<span class="min-w-0 flex-1">
							<span class="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
								<span class="min-w-0 break-words">{v.title}</span>
								{#if v.cause === 'restore'}<Badge>Restore</Badge>{/if}
							</span>
							<span class="block text-xs text-muted">
								{CAUSE[v.cause]}{v.author ? `, ${v.author}` : ''}, {ago(v.createdAt)}
							</span>
						</span>
						<span class="flex items-center gap-2">
							<Button
								size="sm"
								loading={loadingNumber === v.number}
								onclick={() => preview(v.number)}
								aria-label={`Preview version ${v.number}`}>Preview</Button
							>
							{#if canWrite}
								<Button
									size="sm"
									loading={busy === v.number}
									onclick={() => restore(v.number)}
									aria-label={`Restore version ${v.number}`}>Restore</Button
								>
							{/if}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</ResponsiveModal>
