<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	import type { itemShots } from '#lib/server/ops/uiShots.js';
	// -- MODULES -- //
	import { ApiError, api } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Select from '#lib/ui/Select.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';

	// -- TYPES -- //

	type View = Awaited<ReturnType<typeof itemShots>>;
	type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'running';

	// -- REQUIRED PROPS -- //

	let { detail, env }: { detail: ItemView; env: TabEnv } = $props();

	// -- CONSTANTS -- //

	const STATE: Record<string, { label: string; tone: Tone }> = {
		queued: { label: 'Waiting for a runner', tone: 'info' },
		running: { label: 'Running', tone: 'running' },
		done: { label: 'Done', tone: 'success' },
		failed: { label: 'Failed', tone: 'danger' },
		timeout: { label: 'Stuck', tone: 'warning' },
		unavailable: { label: 'Not available', tone: 'warning' }
	};
	const TARGETS = [
		{ value: 'preview', label: 'Build preview' },
		{ value: 'dev', label: 'Dev server' },
		{ value: 'deployed', label: 'Deployed site' }
	];

	// -- STATES -- //

	let view = $state<View | null>(null);
	let failed = $state(false);
	let target = $state('preview');
	let viewport = $state('1440');
	let theme = $state('light');
	let editing = $state(false);
	let markdown = $state('');
	let busy = $state('');
	let message = $state('');

	// -- REACTIVE STATES -- //

	const latest = $derived(view?.runs[0] ?? null);
	const waiting = $derived(
		view?.runs.some((r) => r.state === 'queued' || r.state === 'running') ?? false
	);
	const shown = $derived(view?.runs.find((r) => r.state === 'done') ?? null);
	const pages = $derived.by(() => {
		if (!shown) return [];
		const vp = Number(viewport);
		const afters = shown.results.filter(
			(r) => r.side === 'after' && r.theme === theme && r.viewport === vp
		);
		return afters.map((a) => ({
			key: `${a.row}|${a.state}`,
			after: a,
			before: shown.results.find(
				(r) =>
					r.side === 'before' &&
					r.row === a.row &&
					r.state === a.state &&
					r.theme === theme &&
					r.viewport === vp
			),
			siblings: shown.results.filter(
				(r) => r.side === 'sibling' && r.row === a.row && r.theme === theme && r.viewport === vp
			),
			flags: shown.flags.filter((f) => f.page === a.page && f.theme === theme && f.viewport === vp)
		}));
	});

	// -- FUNCTIONS -- //

	const template = () => `| Page | State | Themes | Accounts | Siblings | Levels | Viewports |
| --- | --- | --- | --- | --- | --- | --- |
| \`/${detail.project.key}/example\` | none | both | default | \`/${detail.project.key}/tasks\` | title, section, body | 1440, 390 |
`;

	async function load() {
		try {
			view = await api<View>(env.org, `/items/${detail.item.ref}/ui-shots`);
			failed = false;
			if (view.themes.length && !view.themes.includes(theme)) theme = view.themes[0];
		} catch {
			failed = true;
		}
	}

	$effect(() => {
		void detail.item.ref;
		void load();
	});
	$effect(() => {
		if (!waiting) return;
		const t = setInterval(() => void load(), 3000);
		return () => clearInterval(t);
	});

	function edit() {
		editing = true;
		markdown =
			view && view.rows.length
				? `| Page | State | Themes | Accounts | Siblings | Levels | Viewports |\n| --- | --- | --- | --- | --- | --- | --- |\n${view.rows
						.map(
							(r) =>
								`| \`${r.page}\` | ${r.stateRecipe ? `\`${r.stateRecipe}\`` : 'none'} | ${r.themes.join(', ')} | ${r.accounts} | ${r.siblings.map((s) => `\`${s}\``).join(', ')} | ${r.levels.join(', ')} | ${r.viewports.join(', ')} |`
						)
						.join('\n')}\n`
				: template();
	}

	async function saveTable() {
		busy = 'save';
		message = '';
		try {
			await toast.promise(
				api(env.org, `/items/${detail.item.ref}/ui-changes`, {
					method: 'PUT',
					body: { markdown }
				}),
				{
					loading: 'Saving the table...',
					success: 'UI changes saved.',
					error: (e) => (e instanceof ApiError ? e.message : 'The table was not saved.')
				}
			);
			editing = false;
			await load();
		} catch (e) {
			message = e instanceof ApiError ? e.message : 'The table was not saved.';
		} finally {
			busy = '';
		}
	}

	async function runShots() {
		busy = 'run';
		message = '';
		try {
			const r = await api<{ unavailable: boolean; reason: string | null }>(
				env.org,
				`/items/${detail.item.ref}/ui-shots`,
				{ body: { target } }
			);
			if (r.unavailable) message = r.reason ?? 'That target is not available.';
			await load();
		} catch (e) {
			message = e instanceof ApiError ? e.message : 'The run was not asked for.';
		} finally {
			busy = '';
		}
	}

	const image = (id: string | undefined) => (id ? `/${env.org}/shot/${id}` : null);
</script>

<div class="flex flex-col gap-4" data-testid="ui-tab">
	{#if failed && !view}
		<ErrorState message="The UI changes did not load." onretry={load} />
	{:else if !view}
		<Skeleton lines={4} />
	{:else}
		<section
			class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)]"
			data-card
			aria-labelledby="ui-table-title"
		>
			<div>
				<h2 id="ui-table-title" class="text-lg font-semibold">UI changes</h2>
				<p class="text-sm text-muted">
					The pages this item adds or changes. Each is opened, measured against the project scale
					and its sibling pages, and photographed.
				</p>
			</div>
			{#if view.rows.length === 0 && !editing}
				<div class="text-sm text-muted">No pages listed yet.</div>
			{:else if !editing}
				<ul class="rounded-lg border border-line" data-testid="ui-rows">
					{#each view.rows as r (r.id)}
						<li
							class="flex flex-col gap-1 border-b border-line px-3 py-2 last:border-b-0"
							data-item
						>
							<span class="text-sm font-medium"
								>{r.page}{r.stateRecipe ? `, ${r.stateRecipe}` : ''}</span
							>
							<span class="text-xs text-muted">
								{r.themes.join(', ')}, {r.viewports.join(' and ')} wide, beside {r.siblings.join(
									', '
								)}, measuring {r.levels.join(', ')}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
			{#if env.canWrite}
				{#if editing}
					<TextArea
						label="Table (Markdown)"
						bind:value={markdown}
						rows={8}
						class="font-mono"
						spellcheck="false"
						hint="Page, State, Themes, Accounts, Siblings, Levels, Viewports. The state only opens things: click:, wait: or scroll:."
					/>
					{#if message}<p role="alert" class="text-sm text-danger">{message}</p>{/if}
					<div class="flex gap-2">
						<Button variant="primary" loading={busy === 'save'} onclick={saveTable}
							>Save table</Button
						>
						<Button variant="ghost" onclick={() => (editing = false)}>Cancel</Button>
					</div>
				{:else}
					<div>
						<Button size="sm" onclick={edit} data-testid="edit-ui-table"
							>{view.rows.length ? 'Edit the table' : 'Add the table'}</Button
						>
					</div>
				{/if}
			{/if}
		</section>

		{#if view.rows.length > 0}
			<section
				class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)]"
				data-card
				aria-labelledby="ui-run-title"
			>
				<div class="flex flex-wrap items-start gap-2">
					<div class="min-w-0 flex-1">
						<h2 id="ui-run-title" class="text-lg font-semibold">Latest run</h2>
						<p class="text-sm text-muted">
							{#if latest}
								{ago(latest.createdAt)}{latest.target
									? `, on the ${latest.target}`
									: ''}{latest.afterCommit ? `, commit ${latest.afterCommit.slice(0, 7)}` : ''}
							{:else}
								Nothing has run yet.
							{/if}
						</p>
					</div>
					{#if latest}
						<Badge tone={STATE[latest.state]?.tone ?? 'neutral'}
							>{STATE[latest.state]?.label ?? latest.state}</Badge
						>
					{/if}
				</div>
				{#if env.canWrite && view.canRun}
					<div class="flex flex-wrap items-end gap-2">
						<Select label="Target" options={TARGETS} bind:value={target} class="w-48" />
						<Button
							variant="primary"
							loading={busy === 'run'}
							onclick={runShots}
							data-testid="run-ui-shots">Run UI shots</Button
						>
					</div>
				{/if}
				{#if message && !editing}<p role="status" class="text-sm text-warning">{message}</p>{/if}
				{#if latest?.reason}<p class="text-xs text-muted">{latest.reason}</p>{/if}
				{#if latest && latest.foreignPaths.length}
					<p class="text-xs text-warning" data-testid="foreign-paths">
						{latest.foreignPaths.length} changed file{latest.foreignPaths.length === 1 ? '' : 's'} in
						the working tree belong to other work, so these shots may show more than this item.
					</p>
				{/if}
				{#if latest && (latest.abortedWrites || latest.outsideCalls)}
					<p class="text-xs text-muted">
						{latest.abortedWrites} write{latest.abortedWrites === 1 ? '' : 's'} the pages tried {latest.abortedWrites ===
						1
							? 'was'
							: 'were'} blocked, and {latest.outsideCalls} call{latest.outsideCalls === 1
							? ''
							: 's'} went to other addresses.
					</p>
				{/if}
			</section>
		{/if}

		{#if shown}
			<section
				class="flex flex-col gap-3"
				aria-labelledby="ui-results-title"
				data-testid="ui-results"
			>
				<div class="flex flex-wrap items-center gap-3">
					<h2 id="ui-results-title" class="text-lg font-semibold">Results</h2>
					<SegmentedControl
						label="Width"
						options={[
							{ value: '1440', label: 'Desktop' },
							{ value: '390', label: 'Phone' }
						]}
						bind:value={viewport}
					/>
					{#if view.themes.length > 1}
						<SegmentedControl
							label="Theme"
							options={view.themes.map((t) => ({ value: t, label: t }))}
							bind:value={theme}
						/>
					{/if}
				</div>
				{#each pages as p, i (i)}
					<div
						class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)]"
						data-card
						data-testid="ui-page"
					>
						<div class="flex flex-wrap items-center gap-2">
							<span class="text-sm font-medium"
								>{p.after.page}{p.after.state ? `, ${p.after.state}` : ''}</span
							>
							{#if p.flags.length}
								<Badge tone="danger">{p.flags.length} to fix</Badge>
							{:else}
								<Badge tone="success">Fits</Badge>
							{/if}
						</div>
						{#if p.flags.length}
							<ul class="flex flex-col gap-1" data-testid="ui-flags">
								{#each p.flags as f, i (i)}
									<li class="text-sm text-danger">{f.text}</li>
								{/each}
							</ul>
						{/if}
						<div class="grid gap-3 sm:grid-cols-2">
							{#if image(p.before?.image)}
								<figure class="flex flex-col gap-1">
									<img
										src={image(p.before?.image)}
										alt={`Before: ${p.after.page}`}
										loading="lazy"
										class="w-full rounded-lg border border-line"
									/>
									<figcaption class="text-xs text-muted">Before, on the deployed site</figcaption>
								</figure>
							{/if}
							{#if image(p.after.image)}
								<figure class="flex flex-col gap-1">
									<img
										src={image(p.after.image)}
										alt={`After: ${p.after.page}`}
										loading="lazy"
										class="w-full rounded-lg border border-line"
									/>
									<figcaption class="text-xs text-muted">After</figcaption>
								</figure>
							{:else if !view.canSeePictures}
								<p class="text-xs text-muted">
									Pictures are private to members. The measurements are above.
								</p>
							{/if}
							{#each p.siblings as s, i (i)}
								{#if image(s.image)}
									<figure class="flex flex-col gap-1">
										<img
											src={image(s.image)}
											alt={`Beside: ${s.page}`}
											loading="lazy"
											class="w-full rounded-lg border border-line"
										/>
										<figcaption class="text-xs text-muted">Beside it: {s.page}</figcaption>
									</figure>
								{/if}
							{/each}
						</div>
					</div>
				{/each}
				{#if pages.length === 0}
					<EmptyState
						title="Nothing was measured at this width"
						text="The table lists other widths or themes. Pick one of them above."
					/>
				{/if}
			</section>
		{/if}
	{/if}
</div>
