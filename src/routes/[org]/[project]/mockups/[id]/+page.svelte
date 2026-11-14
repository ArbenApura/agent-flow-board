<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	import type { CommentRow, PinFilter, PinKey, PinMessage, PinPoint } from '#lib/board/mockups.js';
	import type { ScreenKey } from '#lib/board/mockups.js';
	// -- ENVS -- //
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- DEP-MODULES -- //
	import { tick, untrack } from 'svelte';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ALL_SCREENS, SCREEN_LABEL, inPinFilter, onDevice, pinsOf } from '#lib/board/mockups.js';
	import MockupComments from '#lib/board/MockupComments.svelte';
	import MockupHistoryDrawer from '#lib/board/MockupHistoryDrawer.svelte';
	import MockupLinkDialog from '#lib/board/MockupLinkDialog.svelte';
	import MockupPreview from '#lib/board/MockupPreview.svelte';
	import MockupSource from '#lib/board/MockupSource.svelte';
	import MockupShareDrawer from '#lib/board/MockupShareDrawer.svelte';
	import MockupSwitcher from '#lib/board/MockupSwitcher.svelte';
	import NotesCard from '#lib/board/notes/NotesCard.svelte';
	import ActionMenu, { type MenuItem } from '#lib/ui/ActionMenu.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import History from '@lucide/svelte/icons/history';
	import Link from '@lucide/svelte/icons/link';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import MessageSquarePlus from '@lucide/svelte/icons/message-square-plus';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Trash from '@lucide/svelte/icons/trash';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- STATES -- //

	let historyOpen = $state(false);
	let shareOpen = $state(false);
	let linkOpen = $state(false);
	/** The device the person picked, and the one really on show (the first one until a pick). */
	let picked = $state<ScreenKey>();
	let device = $state<ScreenKey>('laptop');
	/** True while the next click on the mockup places a comment. */
	let pinMode = $state(false);
	/** The spot a person clicked, until they post the comment or cancel. */
	let draft = $state<{ x: number; y: number; hint: string } | null>(null);
	let pinText = $state('');
	let posting = $state(false);
	let drawerOpen = $state(false);
	let filter = $state<PinFilter>('open');
	let selected = $state<string | null>(null);
	let focus = $state<{ id: string; seq: number } | null>(null);
	let focusSeq = 0;
	let seenVersion = untrack(() => data.version);
	let seenDevice = untrack(() => device);
	let hadDraft = false;

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const key = $derived(page.params.project ?? '');
	const base = $derived(`/${org}/${key}`);
	const m = $derived(data.detail.mockup);
	const newest = $derived(m.currentVersion);
	const viewing = $derived(data.version);
	const siblings = $derived(data.siblings);
	const canWrite = $derived(data.detail.canWrite);
	const canManage = $derived(data.detail.canManage);
	const blocked = $derived(m.visibility === 'private');
	// The number of a comment is its place among all the comments of the version, whatever the device
	const numbered = $derived<CommentRow[]>(
		pinsOf(data.pins, viewing).map((p, i) => ({ ...p, n: i + 1 }))
	);
	const here = $derived(numbered.filter((p) => onDevice(p, device)));
	const shown = $derived(here.filter((p) => inPinFilter(p, filter)));
	const framePins = $derived(
		shown.map((p) => ({ id: p.id, x: p.x, y: p.y, n: p.n, done: p.resolved }))
	);
	const openCount = $derived(here.filter((p) => !p.resolved).length);
	const hrefFor = (n: number) =>
		n === newest ? `${base}/mockups/${m.id}` : `${base}/mockups/${m.id}?v=${n}`;
	// Other places with open comments: one more device, one more version
	const elsewhere = $derived.by(() => {
		const rows: {
			key: 'device' | 'version';
			text: string;
			action: string;
			label: string;
			onact?: () => void;
			href?: string;
		}[] = [];
		const other = ALL_SCREENS.find(
			(s) => s !== device && numbered.some((p) => p.device === s && !p.resolved)
		);
		if (other) {
			const k = numbered.filter((p) => p.device === other && !p.resolved).length;
			rows.push({
				key: 'device',
				text: `${k} open on ${SCREEN_LABEL[other]}`,
				action: 'Show',
				label: `Show the ${k} open ${k === 1 ? 'comment' : 'comments'} on ${SCREEN_LABEL[other]}`,
				onact: () => (picked = other)
			});
		}
		const versions = data.pins.filter((p) => p.version !== viewing && !p.resolved);
		const latest = Math.max(0, ...versions.map((p) => p.version));
		if (latest) {
			const k = versions.filter((p) => p.version === latest).length;
			rows.push({
				key: 'version',
				text: `${k} open on version ${latest}`,
				action: 'Open',
				label: `Open version ${latest}`,
				href: hrefFor(latest)
			});
		}
		return rows;
	});
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

	const toggleButton = () => document.getElementById('comment-toggle');

	function closeDrawer() {
		drawerOpen = false;
		document.getElementById('comments-toggle')?.focus();
	}

	function cancelDraft() {
		draft = null;
		pinText = '';
		toggleButton()?.focus();
	}

	/** A click on the mockup while placing: the pin drops there, and a click elsewhere moves it. */
	function placed(pin: PinMessage) {
		draft = { x: pin.x, y: pin.y, hint: pin.hint };
	}

	function moved(point: PinPoint) {
		if (draft) draft = { ...draft, x: point.x, y: point.y };
	}

	async function post() {
		if (!draft || !pinText.trim() || posting) return;
		posting = true;
		try {
			await api(org, `/mockups/${m.id}/pins`, {
				method: 'POST',
				body: {
					version: viewing,
					x: draft.x,
					y: draft.y,
					hint: draft.hint,
					body: pinText.trim(),
					device
				},
				key: newKey()
			});
			draft = null;
			pinText = '';
			pinMode = false;
			filter = 'open';
			drawerOpen = true;
			toggleButton()?.focus();
			await refresh();
		} catch (e) {
			// The box stays open with the text, so nothing typed is lost
			toast.error(e instanceof ApiError ? e.message : 'The comment was not saved.');
		} finally {
			posting = false;
		}
	}

	async function resolve(id: string, resolved: boolean) {
		try {
			await api(org, `/mockup-pins/${id}/resolve`, {
				method: 'POST',
				body: { resolved },
				key: newKey()
			});
			await refresh();
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The comment was not changed.');
		}
	}

	async function removePin(id: string) {
		try {
			await api(org, `/mockup-pins/${id}`, { method: 'DELETE', key: newKey() });
			await refresh();
		} catch (e) {
			toast.error(e instanceof ApiError ? e.message : 'The comment was not removed.');
		}
	}

	/** A comment picked in the list: the mockup scrolls to its pin and the pin pulses. */
	function selectPin(id: string) {
		selected = id;
		focusSeq += 1;
		focus = { id, seq: focusSeq };
	}

	/** A pin clicked on the mockup. The id is only looked up among the comments already loaded, so a page cannot name anything else. */
	function pinClicked(id: string) {
		if (!numbered.some((p) => p.id === id)) return;
		selected = id;
		drawerOpen = true;
	}

	/** The two keys of the viewer. They also arrive from the frame, because the page that has the focus gets the key. */
	function handleKey(keyName: PinKey) {
		if (keyName === 'Escape') {
			if (draft) cancelDraft();
			else if (pinMode) pinMode = false;
			else if (drawerOpen) closeDrawer();
		} else if (canWrite && !draft) pinMode = !pinMode;
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.defaultPrevented) return;
		const name: PinKey | null =
			e.key === 'Escape' ? 'Escape' : e.key === 'c' || e.key === 'C' ? 'c' : null;
		if (!name) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
		// A dialog or a drawer of the page owns the keys while it is open
		if (document.querySelector('[aria-modal="true"]')) return;
		handleKey(name);
	}

	function onBoxKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			cancelDraft();
		} else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			void post();
		}
	}

	// -- REACTIVE STATEMENTS -- //

	// A comment being written belongs to the version it was placed on, so another version closes it
	$effect(() => {
		const v = data.version;
		untrack(() => {
			if (v === seenVersion) return;
			seenVersion = v;
			draft = null;
			pinText = '';
			pinMode = false;
			selected = null;
		});
	});

	// ...and to the device it was placed on
	$effect(() => {
		const d = device;
		untrack(() => {
			if (d === seenDevice) return;
			seenDevice = d;
			// A change the stage made by itself (a resize) keeps what is being written. Only a pick of another device closes it
			if (picked === undefined) return;
			draft = null;
			pinText = '';
			selected = null;
		});
	});

	// A placed pin puts the cursor in its comment box, once, and not again while the pin is dragged
	$effect(() => {
		const has = draft !== null;
		const first = has && !hadDraft;
		hadDraft = has;
		if (!first) return;
		void tick().then(() =>
			document
				.querySelector<HTMLTextAreaElement>('[data-testid="pin-text"]')
				?.focus({ preventScroll: true })
		);
	});
</script>

<svelte:head><title>{m.title}, Mockups</title></svelte:head>
<svelte:window onkeydown={onKeydown} />

<PageFrame class="flex flex-col gap-4 pb-12 max-md:pb-24">
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

	<!-- THE OTHER MOCKUPS OF THIS PLAN: A TRACK OF CHIPS, OR ONE PICKER, WITH PREVIOUS AND NEXT GOING ROUND -->
	{#if siblings.length > 1}
		<MockupSwitcher items={siblings} current={m.id} hrefOf={(id) => `${base}/mockups/${id}`} />
	{/if}

	<Notice tone="info" data-testid="reference-notice">
		{#if data.detail.plan}
			A build of this plan follows this mockup. Colours, spacing, sizes and type follow the
			project's tokens, and the Free notes list anything else that may differ.
		{:else}
			A design idea. Once it is linked to a plan, a build follows it.
		{/if}
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

	<!-- THE CARD MUST NOT CLIP, OR THE TOOLBAR CANNOT STAY UNDER THE TOP BAR WHILE THE PAGE SCROLLS -->
	<Card class="overflow-visible">
		{#snippet header()}
			<div class="min-w-0 flex-1">
				<h2 class="flex items-center gap-2 text-lg leading-6 font-semibold">
					Preview
					<Badge tone={viewing === newest ? 'success' : 'neutral'}>v{viewing}</Badge>
				</h2>
				<p class="text-xs text-muted max-sm:hidden">
					Sandboxed: it cannot reach the board or your sign in.
				</p>
				<p class="text-xs text-muted sm:hidden">Sandboxed preview.</p>
			</div>
		{/snippet}
		<MockupPreview
			src={data.src}
			screens={data.screens}
			title={`${m.title}, version ${viewing}`}
			pins={framePins}
			{pinMode}
			draft={draft ? { x: draft.x, y: draft.y } : null}
			bind:picked
			sticky
			flush
			{focus}
			ondevice={(d) => (device = d)}
			onpin={placed}
			onmove={moved}
			onpinclick={pinClicked}
			onkey={handleKey}
		>
			{#snippet toolbar()}
				<Button
					id="comments-toggle"
					onclick={() => (drawerOpen = !drawerOpen)}
					aria-expanded={drawerOpen}
					aria-controls="mockup-comments"
					data-testid="comments-button"
					aria-label={`Comments, ${openCount} open`}
					class={cn(
						'max-lg:w-10 max-lg:overflow-visible max-lg:px-0 max-sm:w-11',
						drawerOpen && 'border-accent! bg-accent-soft! text-accent-text!'
					)}
				>
					<MessageSquare size={20} />
					<span class="max-lg:hidden">Comments</span>
					<!-- BELOW 1024 PX THE COUNT IS A SMALL BADGE ON THE ICON, SO THE BUTTON STAYS 40 OR 44 PX WIDE -->
					<Badge
						tone="accent"
						class="px-2 max-lg:absolute max-lg:-top-1.5 max-lg:-right-1.5 max-lg:box-content max-lg:min-w-4 max-lg:justify-center max-lg:border-2 max-lg:border-surface max-lg:px-1 max-lg:leading-4"
						>{openCount}</Badge
					>
				</Button>
				{#if canWrite}
					<Button
						id="comment-toggle"
						onclick={() => (pinMode = !pinMode)}
						aria-pressed={pinMode}
						data-testid="add-pin"
						aria-label={pinMode ? 'Placing a comment' : 'Add a comment'}
						class={cn(
							'max-lg:w-10 max-lg:px-0 max-sm:w-11',
							pinMode && 'border-accent! bg-accent-soft! text-accent-text!'
						)}
					>
						<MessageSquarePlus size={20} />
						<span class="max-lg:hidden">{pinMode ? 'Placing a comment' : 'Add a comment'}</span>
						<kbd
							class="rounded border border-line bg-surface px-1.5 font-mono text-badge text-muted max-lg:hidden"
							>C</kbd
						>
					</Button>
				{/if}
			{/snippet}
			{#snippet composer()}
				<form
					class="flex flex-col gap-3 rounded-xl border border-accent bg-surface p-4 shadow-[var(--shadow-pop)]"
					onsubmit={(e) => {
						e.preventDefault();
						void post();
					}}
					data-testid="pin-composer"
				>
					<TextArea
						label={`Your comment on ${draft?.hint || 'this spot'}`}
						rows={3}
						bind:value={pinText}
						maxlength={2000}
						placeholder="What should change here?"
						onkeydown={onBoxKey}
						data-testid="pin-text"
					/>
					<div class="flex items-center justify-end gap-3">
						<span
							class="flex min-w-0 flex-1 items-center gap-1 text-xs whitespace-nowrap text-muted max-sm:hidden"
							><kbd class="rounded border border-line bg-surface px-1.5 font-mono text-badge"
								>Ctrl</kbd
							>+<kbd class="rounded border border-line bg-surface px-1.5 font-mono text-badge"
								>Enter</kbd
							>
							to post</span
						>
						<Button size="sm" onclick={cancelDraft} disabled={posting}>Cancel</Button>
						<Button
							size="sm"
							variant="primary"
							type="submit"
							loading={posting}
							disabled={!pinText.trim()}>Post</Button
						>
					</div>
				</form>
			{/snippet}
			{#snippet drawer()}
				<MockupComments
					id="mockup-comments"
					open={drawerOpen}
					pins={shown}
					bind:filter
					{openCount}
					device={SCREEN_LABEL[device]}
					{selected}
					{canWrite}
					{elsewhere}
					onclose={closeDrawer}
					ontoggle={() => (drawerOpen = !drawerOpen)}
					onselect={selectPin}
					onresolve={resolve}
					onremove={removePin}
				/>
			{/snippet}
		</MockupPreview>
	</Card>

	<!-- WHAT THIS VERSION COSTS TO READ AND THE PARTS IT COMES IN -->
	<MockupSource source={data.source} />

	<!-- NOTES THAT LINK TO THIS MOCKUP, UNDER THE PREVIEW -->
	<NotesCard
		{org}
		project={key}
		target={{ kind: 'mockup', id: m.id, ref: null }}
		role={data.summary?.role}
		{canWrite}
	/>
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
