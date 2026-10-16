<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import GitBranch from '@lucide/svelte/icons/git-branch';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- STATES -- //

	let busy = $state(false);
	let error = $state('');
	let installationId = $state('');
	let repoName = $state('');
	let laterOpen = $state(false);
	let laterAt = $state('');
	let laterError = $state('');
	let disconnecting = $state(false);

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const pub = $derived(data.state);
	const link = $derived(pub?.link ?? null);
	const preview = $derived(data.preview);
	const base = $derived(`/api/v1/orgs/${org}/projects/${key}/publish`);
	const tone = (s: string) =>
		s === 'done'
			? 'success'
			: s === 'failed'
				? 'danger'
				: s === 'cancelled'
					? 'neutral'
					: 'running';

	// -- FUNCTIONS -- //

	/** A failed call already set the inline message; this turns it into a rejection for the promise toast. */
	function settled<T>(result: T | null): T {
		if (result === null) throw new Error('The call failed.');
		return result;
	}

	async function call(path: string, init: { method?: string; body?: unknown } = {}) {
		error = '';
		busy = true;
		try {
			const res = await fetch(`${base}${path}`, {
				method: init.method ?? 'POST',
				headers: {
					'content-type': 'application/json',
					'idempotency-key': newKey()
				},
				body: init.body === undefined ? undefined : JSON.stringify(init.body)
			});
			const json = await res.json().catch(() => null);
			if (!res.ok)
				throw new ApiError(
					res.status,
					json?.error?.code ?? 'ERROR',
					json?.error?.message ?? 'That did not work.'
				);
			await invalidate('afb:project');
			return json;
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'That did not work.';
			return null;
		} finally {
			busy = false;
		}
	}

	async function connect(repo: string, installation: string) {
		try {
			await toast.promise(
				call('/link', { method: 'PUT', body: { installationId: installation, repo } }).then(
					settled
				),
				{
					loading: `Connecting to ${repo}...`,
					success: `Connected to ${repo}.`,
					error: () => error || 'That did not work.'
				}
			);
		} catch {
			// The promise toast and the inline message already show the failure
		}
	}

	async function publishNow() {
		try {
			await toast.promise(
				call('', { body: {} })
					.then(settled)
					.then((j) => {
						// A failed run is a failure: the error toast stays and the message shows inline too
						if (j.run.state === 'failed') {
							error = j.run.error ?? 'The publish failed.';
							throw new Error(error);
						}
						return j;
					}),
				{
					loading: 'Publishing...',
					success: (j) =>
						j.run.state === 'done'
							? (j.run.message ?? 'Published.')
							: j.run.state === 'pending'
								? 'GitHub asked to slow down. Trying again shortly.'
								: 'The publish did not finish.',
					error: () => error || 'The publish failed.'
				}
			);
		} catch {
			// The promise toast and the inline message already show the failure
		}
	}

	async function publishLater() {
		laterError = '';
		if (!laterAt) {
			laterError = 'Pick a date and time.';
			return;
		}
		busy = true;
		try {
			await toast.promise(
				api(org, `/projects/${key}/publish`, {
					body: { runAt: new Date(laterAt).toISOString() },
					key: newKey()
				}),
				{
					loading: 'Scheduling...',
					success: 'Scheduled. You can cancel it until it starts.',
					error: (e) => (e instanceof ApiError ? e.message : 'That did not work.')
				}
			);
			laterOpen = false;
			laterAt = '';
			await invalidate('afb:project');
		} catch (e) {
			laterError = e instanceof ApiError ? e.message : 'That did not work.';
		} finally {
			busy = false;
		}
	}

	async function cancel(id: string) {
		try {
			await toast.promise(api(org, `/publish-runs/${id}/cancel`, { method: 'POST', body: {} }), {
				loading: 'Cancelling...',
				success: 'Cancelled.',
				error: (e) => (e instanceof ApiError ? e.message : 'It could not be cancelled.')
			});
			await invalidate('afb:project');
		} catch {
			// The promise toast already shows the failure
		}
	}

	async function disconnect() {
		try {
			await toast.promise(call('/link', { method: 'DELETE' }).then(settled), {
				loading: 'Disconnecting...',
				success: 'Disconnected.',
				error: () => error || 'That did not work.'
			});
		} catch {
			// The promise toast and the inline message already show the failure
		}
	}

	const sha = (s: string | null) => (s ? s.slice(0, 7) : '');
</script>

<svelte:head><title>Publish, {data.summary?.project.name ?? ''}</title></svelte:head>

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader
		title="Publish"
		context="A readable reference copy of this project in a GitHub repository. It is not a backup."
	/>

	{#if !pub}
		<EmptyState title="Not available" text="You do not have access to this project." />
	{:else if !pub.configured}
		<EmptyState
			title="GitHub publishing is not set up on this server"
			text="An operator adds the GitHub App settings to the server first. Plans stay in this app either way."
		/>
	{:else if !link}
		{#if !pub.canPublish}
			<EmptyState
				title="No repository is connected"
				text="An admin or owner can connect a GitHub repository to publish this project."
			/>
		{:else}
			<Card data-testid="connect-card">
				{#snippet header()}
					<GitBranch size={18} class="text-muted" aria-hidden="true" />
					<h2 class="text-lg font-semibold">Connect a repository</h2>
				{/snippet}
				<div class="flex flex-col gap-3">
					{#if data.repos.length}
						<p class="text-sm text-muted">Pick the repository to publish into.</p>
						<ul class="rounded-lg border border-line" data-testid="repo-list">
							{#each data.repos as r (r.fullName)}
								<li
									class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
									data-row
								>
									<span class="min-w-0 flex-1 truncate text-sm font-medium">{r.fullName}</span>
									<Badge tone={r.private ? 'neutral' : 'warning'}
										>{r.private ? 'private' : 'public'}</Badge
									>
									<Button
										size="sm"
										variant="primary"
										disabled={busy}
										onclick={() => connect(r.fullName, data.installation ?? '')}>Connect</Button
									>
								</li>
							{/each}
						</ul>
					{:else}
						{#if data.repoError}<p class="text-sm text-danger" role="alert">
								{data.repoError}
							</p>{/if}
						{#if data.canInstall}
							<p class="text-sm text-muted">
								Install the GitHub App on the repository you want, then come back here to pick it.
							</p>
							<div>
								<Button variant="primary" href={`/github/install?org=${org}&project=${key}`}
									>Install the GitHub App</Button
								>
							</div>
						{/if}
						<form
							class="flex flex-wrap items-end gap-2"
							onsubmit={(e) => {
								e.preventDefault();
								void connect(repoName.trim(), installationId.trim());
							}}
						>
							<TextField
								label="Installation number"
								placeholder="For example 12345678"
								bind:value={installationId}
								class="w-44"
								data-testid="installation-id"
								required
							/>
							<TextField
								label="Repository, written owner/name"
								placeholder="For example acme/plans"
								bind:value={repoName}
								class="min-w-56 flex-1"
								data-testid="repo-name"
								required
							/>
							<Button type="submit" variant="primary" loading={busy} data-testid="connect-repo"
								>Connect</Button
							>
						</form>
					{/if}
					{#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}
				</div>
			</Card>
		{/if}
	{:else}
		<section
			class="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)]"
			data-card
		>
			<GitBranch size={20} class="text-muted" />
			<div class="min-w-0 flex-1">
				<a
					class="text-sm font-medium text-accent-text hover:underline"
					href={`${data.webUrl}/${link.repo}`}
					target="_blank"
					rel="noopener noreferrer"
					data-testid="repo-link">{link.repo}</a
				>
				<div class="text-xs text-muted">branch {link.branch}, folder {link.path}</div>
			</div>
			<span data-testid="repo-visibility"
				><Badge tone={link.repoVisibility === 'public' ? 'warning' : 'neutral'}
					>{link.repoVisibility}</Badge
				></span
			>
			{#if pub.canPublish}
				<Button size="sm" variant="ghost" onclick={() => (disconnecting = true)}>Disconnect</Button>
			{/if}
		</section>

		{#if link.pausedReason}
			<Notice tone="warning" data-testid="paused"
				>Automatic publish is paused. {link.pausedReason}</Notice
			>
		{/if}
		{#if preview?.refusal}
			<Notice tone="danger" data-testid="refusal">{preview.refusal}</Notice>
		{/if}
		{#if error}<p class="text-sm text-danger" role="alert" data-testid="publish-error">
				{error}
			</p>{/if}

		{#if pub.canPublish && preview}
			<section class="flex flex-col gap-2" aria-label="What would change">
				<h2 class="text-lg font-semibold">What would change</h2>
				{#if preview.diff.total === 0}
					<p class="text-sm text-muted" data-testid="no-changes">
						Nothing has changed since the last publish.
					</p>
				{:else}
					<ul
						class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
						data-testid="diff"
					>
						{#each preview.diff.added as r (r)}
							<li
								class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
								data-row
							>
								<span class="w-24 shrink-0 font-mono text-xs text-muted">{r}</span><Badge
									tone="success">new</Badge
								>
							</li>
						{/each}
						{#each preview.diff.changed as r (r)}
							<li
								class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
								data-row
							>
								<span class="w-24 shrink-0 font-mono text-xs text-muted">{r}</span><Badge
									tone="info">changed</Badge
								>
							</li>
						{/each}
						{#each preview.diff.removed as r (r)}
							<li
								class="flex min-h-12 items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
								data-row
							>
								<span class="w-24 shrink-0 font-mono text-xs text-muted">{r}</span><Badge
									tone="danger">removed</Badge
								>
							</li>
						{/each}
					</ul>
				{/if}
				<div class="text-xs text-muted">
					{preview.itemCount} public {preview.itemCount === 1 ? 'item' : 'items'}, {preview.fileCount}
					files.
					{#if preview.privateItems}{preview.privateItems} private
						{preview.privateItems === 1 ? 'item stays' : 'items stay'} out.{/if}
				</div>
			</section>

			<div class="flex flex-wrap gap-2">
				<Button variant="primary" loading={busy} onclick={publishNow} data-testid="publish-now"
					>Publish now</Button
				>
				<Button onclick={() => (laterOpen = true)} data-testid="publish-later">Publish later</Button
				>
			</div>
		{/if}

		{#if pub.pending}
			<section
				class="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)]"
				data-card
				data-testid="pending"
			>
				<Badge tone="running">waiting</Badge>
				<span class="min-w-0 flex-1 text-sm">
					Publishes {new Date(pub.pending.runAt).toLocaleString('en')}
					{#if pub.pending.error}<span class="block text-xs text-muted">{pub.pending.error}</span
						>{/if}
				</span>
				{#if pub.canPublish}
					<Button size="sm" onclick={() => cancel(pub.pending!.id)} data-testid="cancel-publish"
						>Cancel</Button
					>
				{/if}
			</section>
		{/if}

		<section class="flex flex-col gap-2" aria-label="Publish history">
			<h2 class="text-lg font-semibold">History</h2>
			{#if pub.runs.length === 0}
				<p class="text-sm text-muted">Nothing has been published yet.</p>
			{:else}
				<ul
					class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
					data-testid="runs"
				>
					{#each pub.runs as r (r.id)}
						<li
							class="flex min-h-12 flex-wrap items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
							data-row
							data-testid="run"
							data-state={r.state}
						>
							<Badge tone={tone(r.state)}>{r.state}</Badge>
							<span class="min-w-0 flex-1 text-sm">
								{r.state === 'failed' ? r.error : (r.message ?? 'Waiting')}
								{#if r.commitSha}
									<a
										class="ml-1 font-mono text-xs text-accent-text hover:underline"
										href={`${data.webUrl}/${r.repo}/commit/${r.commitSha}`}
										target="_blank"
										rel="noopener noreferrer">{sha(r.commitSha)}</a
									>
								{/if}
								<span class="block text-xs text-muted">{r.trigger}, {ago(r.updatedAt)}</span>
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</PageFrame>

<ResponsiveModal
	open={laterOpen}
	onclose={() => (laterOpen = false)}
	title="Publish later"
	size="sm"
	{busy}
>
	<form
		class="flex flex-col gap-3"
		onsubmit={(e) => {
			e.preventDefault();
			void publishLater();
		}}
	>
		<TextField
			label="Date and time"
			type="datetime-local"
			bind:value={laterAt}
			error={laterError}
			hint="You can cancel it any time before it starts."
			data-testid="later-at"
		/>
		<div class="flex justify-end gap-2">
			<Button onclick={() => (laterOpen = false)} disabled={busy}>Cancel</Button>
			<Button type="submit" variant="primary" loading={busy} data-testid="later-submit"
				>Schedule</Button
			>
		</div>
	</form>
</ResponsiveModal>

<ConfirmDialog
	open={disconnecting}
	onclose={() => (disconnecting = false)}
	title="Disconnect this repository"
	confirmLabel="Disconnect"
	tone="danger"
	onconfirm={disconnect}
>
	Waiting publishes are cancelled. The files already in the repository stay there.
</ConfirmDialog>
