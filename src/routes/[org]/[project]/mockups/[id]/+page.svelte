<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	import type { PinMessage, ScreenKey } from '#lib/board/mockups.js';
	// -- ENVS -- //
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { pinsOf, screensOf } from '#lib/board/mockups.js';
	import { ago } from '#lib/board/status.js';
	import MockupHistoryDrawer from '#lib/board/MockupHistoryDrawer.svelte';
	import MockupLinkDialog from '#lib/board/MockupLinkDialog.svelte';
	import MockupPreview from '#lib/board/MockupPreview.svelte';
	import MockupShareDrawer from '#lib/board/MockupShareDrawer.svelte';
	import ActionMenu, { type MenuItem } from '#lib/ui/ActionMenu.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import History from '@lucide/svelte/icons/history';
	import Link from '@lucide/svelte/icons/link';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Trash from '@lucide/svelte/icons/trash';
	import X from '@lucide/svelte/icons/x';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- STATES -- //

	let screen = $state<ScreenKey>('laptop');
	let historyOpen = $state(false);
	let shareOpen = $state(false);
	let linkOpen = $state(false);
	let pinMode = $state(false);
	/** The spot a person clicked, until they post the comment or cancel. */
	let pending = $state<PinMessage | null>(null);
	let pinText = $state('');
	let posting = $state(false);
	let seenVersion = untrack(() => data.version);

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const base = $derived(`/${org}/${key}`);
	const m = $derived(data.detail.mockup);
	const screens = $derived(screensOf(data.screens));
	const newest = $derived(m.currentVersion);
	const viewing = $derived(data.version);
	const onPins = $derived(pinsOf(data.pins, viewing));
	const otherPins = $derived(data.pins.filter((p) => p.version !== viewing));
	const canWrite = $derived(data.detail.canWrite);
	const canManage = $derived(data.detail.canManage);
	const blocked = $derived(m.visibility === 'private');
	const hrefFor = (n: number) =>
		n === newest ? `${base}/mockups/${m.id}` : `${base}/mockups/${m.id}?v=${n}`;
	const menu = $derived<MenuItem[]>(
		canWrite
			? [
					{ label: 'Link to a plan', icon: Link, onselect: () => (linkOpen = true) },
					{ label: 'Move to the trash', icon: Trash, danger: true, onselect: () => void trash() }
				]
			: []
	);

	// -- FUNCTIONS -- //

	const refresh = async () => {
		await invalidate('afb:project');
	};

	async function restore(n: number) {
		try {
			await toast.promise(
				api(org, `/mockups/${m.id}/restore`, {
					method: 'POST',
					body: { version: n },
					key: newKey()
				}),
				{
					loading: `Restoring version ${n}...`,
					success: `Version ${n} is now the newest.`,
					error: (e) => (e instanceof ApiError ? e.message : 'The version was not restored.')
				}
			);
			historyOpen = false;
			await goto(`${base}/mockups/${m.id}`, { invalidateAll: true });
		} catch {
			// The promise toast already shows the failure
		}
	}

	async function trash() {
		const yes = await askConfirm({
			title: 'Move this mockup to the trash?',
			body: 'It stays in the trash for 30 days. Its public link goes off, and bringing it back does not switch the link on again.',
			confirmLabel: 'Move to the trash',
			tone: 'danger'
		});
		if (!yes) return;
		try {
			await toast.promise(api(org, `/mockups/${m.id}`, { method: 'DELETE', key: newKey() }), {
				loading: 'Moving it to the trash...',
				success: 'Moved to the trash.',
				error: (e) => (e instanceof ApiError ? e.message : 'It was not moved.')
			});
			await goto(`${base}/mockups`, { invalidateAll: true });
		} catch {
			// The promise toast already shows the failure
		}
	}

	function placed(pin: PinMessage) {
		pending = pin;
		pinMode = false;
		pinText = '';
	}

	async function post() {
		if (!pending || !pinText.trim()) return;
		posting = true;
		try {
			await api(org, `/mockups/${m.id}/pins`, {
				method: 'POST',
				body: {
					version: viewing,
					x: pending.x,
					y: pending.y,
					hint: pending.hint,
					body: pinText.trim()
				},
				key: newKey()
			});
			pending = null;
			pinText = '';
			await refresh();
		} catch (e) {
			// The composer stays open with the text, so nothing typed is lost
			toast.error(e instanceof ApiError ? e.message : 'The pin was not saved.');
		} finally {
			posting = false;
		}
	}

	async function removePin(id: string) {
		try {
			await api(org, `/mockup-pins/${id}`, { method: 'DELETE', key: newKey() });
			await refresh();
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The pin was not removed.');
		}
	}

	// -- REACTIVE STATEMENTS -- //

	// A pin being written belongs to the version it was placed on, so another version closes it
	$effect(() => {
		const v = data.version;
		untrack(() => {
			if (v === seenVersion) return;
			seenVersion = v;
			pending = null;
			pinText = '';
			pinMode = false;
		});
	});

	// The first screen is the laptop when the project offers it, otherwise the first one it does
	$effect(() => {
		const offered = screens;
		untrack(() => {
			if (!offered.includes(screen)) screen = offered.includes('laptop') ? 'laptop' : offered[0];
		});
	});
</script>

<svelte:head><title>{m.title}, Mockups</title></svelte:head>

<PageFrame class="flex flex-col gap-4 pb-12">
	<PageHeader
		class="mb-2!"
		title={m.title}
		back={{ href: `${base}/mockups`, label: 'Back to the mockups' }}
		context={`Version ${viewing} of ${newest}${data.detail.plan ? `, for ${data.detail.plan.ref}` : ', not on a plan'}.`}
	>
		{#snippet actions()}
			<Button onclick={() => (shareOpen = true)} data-testid="share-button">
				<Share2 size={16} /> Share
			</Button>
			<Button onclick={() => (historyOpen = true)} data-testid="history-button">
				<History size={16} /> History
			</Button>
			{#if menu.length}<ActionMenu items={menu} label="Mockup actions" />{/if}
		{/snippet}
	</PageHeader>

	<Notice tone="info" data-testid="reference-notice">
		A mockup is inspiration, never the spec. The build follows the project's real components and
		design rules first.
		{#if m.publicLinkOn}
			<Badge tone="info" class="ml-1">Public link on</Badge>
		{/if}
	</Notice>

	{#if viewing !== newest}
		<Notice tone="warning" data-testid="not-current-notice">
			<span class="flex flex-wrap items-center gap-x-3 gap-y-2">
				<span>You are looking at version {viewing}. The newest is version {newest}.</span>
				<span class="flex gap-2">
					<Button size="sm" href={`${base}/mockups/${m.id}`}>Show the newest</Button>
					{#if canWrite}
						<Button size="sm" onclick={() => restore(viewing)}>Restore this version</Button>
					{/if}
				</span>
			</span>
		</Notice>
	{/if}

	<Card>
		{#snippet header()}
			<div class="flex min-w-0 flex-1 items-center gap-3">
				<div class="min-w-0 flex-1">
					<h2 class="text-lg leading-6 font-semibold">Preview</h2>
					<p class="text-xs text-muted">Sandboxed: it cannot reach the board or your sign in.</p>
				</div>
				<Badge tone={viewing === newest ? 'success' : 'neutral'}>v{viewing}</Badge>
				{#if canWrite}
					<Button
						onclick={() => (pinMode = !pinMode)}
						aria-pressed={pinMode}
						data-testid="add-pin"
						class={pinMode ? 'border-accent! bg-accent-soft! text-accent-text!' : ''}
					>
						<MapPin size={16} />
						{pinMode ? 'Cancel the pin' : 'Add a pin'}
					</Button>
				{/if}
			</div>
		{/snippet}
		<MockupPreview
			src={data.src}
			{screens}
			title={`${m.title}, version ${viewing}`}
			pins={onPins}
			{pinMode}
			onpin={placed}
			bind:screen
		/>
	</Card>

	<Card>
		{#snippet header()}
			<h2 class="flex items-center gap-2 text-lg leading-6 font-semibold">
				Pinned comments
				<span
					data-count
					class="rounded-full bg-raised px-2 py-0.5 text-badge font-semibold text-muted tabular-nums"
					>{onPins.length}</span
				>
			</h2>
		{/snippet}
		<div class="flex flex-col gap-3" data-testid="pins">
			{#if pending}
				<form
					class="flex flex-col gap-2 rounded-lg border border-accent bg-accent-soft/40 p-3"
					onsubmit={(e) => {
						e.preventDefault();
						void post();
					}}
					data-testid="pin-composer"
				>
					<TextArea
						label={`Your comment on ${pending.hint || 'this spot'}`}
						rows={3}
						bind:value={pinText}
						maxlength={2000}
						placeholder="What should change here?"
						data-testid="pin-text"
					/>
					<div class="flex justify-end gap-2">
						<Button type="button" onclick={() => (pending = null)} disabled={posting}>Cancel</Button
						>
						<Button variant="primary" type="submit" loading={posting} disabled={!pinText.trim()}
							>Post</Button
						>
					</div>
				</form>
			{/if}
			{#if onPins.length === 0 && !pending}
				<p class="text-sm text-muted">
					{canWrite
						? 'No pins on this version. Press Add a pin, click the spot on the mockup and say what should change.'
						: 'No pins on this version.'}
				</p>
			{/if}
			<ol class="flex flex-col gap-2">
				{#each onPins as p, i (p.id)}
					<li
						class="flex items-start gap-3 rounded-lg border border-line px-3 py-2.5"
						data-testid="pin"
					>
						<span
							class="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-badge font-semibold text-accent-ink"
							>{i + 1}</span
						>
						<!-- PLAIN TEXT ONLY: A PIN IS WRITTEN BY A PERSON, SO IT IS NEVER RENDERED AS MARKUP -->
						<span class="min-w-0 flex-1 text-sm">
							<span class="block text-xs text-muted">{p.author}, {ago(p.createdAt)}</span>
							<span class="[overflow-wrap:anywhere] whitespace-pre-wrap text-ink">{p.body}</span>
						</span>
						{#if canWrite}
							<Button
								size="sm"
								variant="subtle"
								iconOnly
								aria-label={`Remove pin ${i + 1}`}
								onclick={() => removePin(p.id)}
							>
								<X size={16} />
							</Button>
						{/if}
					</li>
				{/each}
			</ol>
			{#if otherPins.length}
				<div class="flex flex-col gap-2 border-t border-line pt-3">
					<p class="text-xs font-medium text-muted">On other versions</p>
					<ul class="flex flex-col gap-1.5">
						{#each otherPins as p (p.id)}
							<li class="flex items-start gap-3 text-sm text-muted" data-testid="pin-other">
								<a
									href={hrefFor(p.version)}
									class="shrink-0 cursor-pointer rounded-md bg-raised px-1.5 font-mono text-xs text-muted hover:text-ink"
									>v{p.version}</a
								>
								<span class="min-w-0 [overflow-wrap:anywhere]">{p.body}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	</Card>
</PageFrame>

<MockupHistoryDrawer
	open={historyOpen}
	onclose={() => (historyOpen = false)}
	versions={data.detail.versions}
	current={newest}
	{viewing}
	{canWrite}
	{hrefFor}
	onrestore={restore}
/>
<MockupShareDrawer
	open={shareOpen}
	onclose={() => (shareOpen = false)}
	{org}
	mockupId={m.id}
	linkOn={m.publicLinkOn}
	{blocked}
	{canManage}
	onchange={refresh}
/>
<MockupLinkDialog
	open={linkOpen}
	onclose={() => (linkOpen = false)}
	{org}
	mockupId={m.id}
	currentRef={data.detail.plan?.ref ?? null}
	onchange={refresh}
/>
