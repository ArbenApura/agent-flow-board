<script lang="ts">
	// IMPORTED DEP-MODULES
	import { onMount } from 'svelte';
	// IMPORTED MODULES
	import { applyMode, type ModeChoice } from '#lib/theme/mode.js';
	import { checkPalette, generatePalette } from '#lib/theme/palette.js';
	import ActionMenu from '#lib/ui/ActionMenu.svelte';
	import Avatar from '#lib/ui/Avatar.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import Checkbox from '#lib/ui/Checkbox.svelte';
	import ConfirmDialog from '#lib/ui/ConfirmDialog.svelte';
	import DatePickerField from '#lib/ui/DatePickerField.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Illustration from '#lib/ui/Illustration.svelte';
	import ErrorState from '#lib/ui/ErrorState.svelte';
	import OfflineBanner from '#lib/ui/OfflineBanner.svelte';
	import Pagination from '#lib/ui/Pagination.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PhaseStepper from '#lib/ui/PhaseStepper.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import ProgressRing from '#lib/ui/ProgressRing.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import RunningBadge from '#lib/ui/RunningBadge.svelte';
	import SearchStatus from '#lib/ui/SearchStatus.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import Select from '#lib/ui/Select.svelte';
	import SelectField from '#lib/ui/SelectField.svelte';
	import Skeleton from '#lib/ui/Skeleton.svelte';
	import Texture from '#lib/ui/Texture.svelte';
	import StaleWriteDialog from '#lib/ui/StaleWriteDialog.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TagInput from '#lib/ui/TagInput.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import TimePickerField from '#lib/ui/TimePickerField.svelte';
	import Tooltip from '#lib/ui/Tooltip.svelte';
	import VirtualList from '#lib/ui/VirtualList.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Archive from '@lucide/svelte/icons/archive';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash from '@lucide/svelte/icons/trash';
	import Settings from '@lucide/svelte/icons/settings';

	// -- CONSTANTS -- //

	const STATUS = [
		{ value: 'planned', label: 'Planned' },
		{ value: 'progress', label: 'In progress', hint: 'Work has started' },
		{ value: 'review', label: 'In review' },
		{ value: 'hold', label: 'On hold', disabled: true }
	];
	const ROWS = Array.from({ length: 5000 }, (_, i) => ({
		id: `ACME-${i + 1}`,
		title: `Item number ${i + 1}`
	}));

	// -- CONSTANTS -- //

	const ILLUSTRATIONS = ['items', 'search', 'inbox', 'error', 'welcome'] as const;

	// -- STATES -- //

	let mode = $state<ModeChoice>('system');
	let text = $state('');
	let area = $state('');
	let checked = $state(true);
	let on = $state(true);
	let seg = $state('list');
	let tags = $state(['frontend']);
	let status = $state<string | undefined>('progress');
	let date = $state('2026-10-15');
	let time = $state('09:30');
	let page = $state(3);
	let modal = $state(false);
	let confirm = $state(false);
	let stale = $state(false);
	let popover = $state(false);
	// A pale yellow on purpose: the generator has to adjust it to pass AA
	// eslint-disable-next-line afb/no-literal-colours
	let seed = $state('#fde047');

	// -- REACTIVE STATES -- //

	const palette = $derived.by(() => {
		try {
			return generatePalette(seed);
		} catch {
			return null;
		}
	});
	const pairs = $derived(palette ? checkPalette(palette) : []);

	// -- FUNCTIONS -- //

	function setMode(next: string) {
		mode = next as ModeChoice;
		applyMode(mode);
	}

	// -- LIFECYCLES -- //

	onMount(() => {
		const cookie = document.cookie.match(/afb-mode=(light|dark|system)/)?.[1];
		mode = (cookie as ModeChoice | undefined) ?? 'system';
	});
</script>

<svelte:head><title>Component gallery</title></svelte:head>

<PageFrame class="flex flex-col gap-6 py-8 pb-12">
	<header class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-xl font-semibold tracking-tight sm:text-2xl">Component gallery</h1>
			<p class="text-sm text-muted">Every component and state, in light and dark.</p>
		</div>
		<SegmentedControl
			label="Theme mode"
			bind:value={mode}
			onchange={setMode}
			options={[
				{ value: 'light', label: 'Light' },
				{ value: 'dark', label: 'Dark' },
				{ value: 'system', label: 'System' }
			]}
		/>
	</header>

	<Card data-testid="g-buttons">
		{#snippet header()}<h2 class="text-lg font-semibold">Buttons and badges</h2>{/snippet}
		<div class="flex flex-wrap items-center gap-3">
			<Button variant="primary">Save changes</Button>
			<Button>Cancel</Button>
			<Button variant="ghost">Skip</Button>
			<Button variant="subtle">Sidebar row</Button>
			<Button variant="ghost" tone="danger">Remove</Button>
			<Button tone="danger">End it</Button>
			<Button variant="danger">Delete</Button>
			<Button variant="primary" loading>Saving</Button>
			<Button disabled>Disabled</Button>
			<Button size="sm">Compact</Button>
			<Button iconOnly aria-label="Edit"><Pencil size={20} /></Button>
			<Avatar name="Maria Santos" />
			<Avatar name="Claude Code" kind="agent" />
		</div>
		<div class="mt-4 flex flex-wrap items-center gap-2">
			<Badge>Neutral</Badge>
			<Badge tone="accent">Accent</Badge>
			<Badge tone="success" dot>Completed</Badge>
			<Badge tone="warning" dot>In review</Badge>
			<Badge tone="danger" dot>On hold</Badge>
			<Badge tone="info" dot>In progress</Badge>
			<RunningBadge tool="Claude Code" title="SAVED_CARDS: ACME-142" phase="2" />
			<RunningBadge tool="Cursor" />
		</div>
	</Card>

	<Card data-testid="g-fields">
		{#snippet header()}<h2 class="text-lg font-semibold">Fields and controls</h2>{/snippet}
		<div class="grid gap-4 sm:grid-cols-2">
			<TextField
				label="Project name"
				bind:value={text}
				placeholder="Checkout rebuild"
				hint="Shown in the project switcher."
			/>
			<TextField label="Email" value="maria@" error="Enter a full email address." />
			<TextArea label="Description" bind:value={area} hint="One or two sentences." />
			<TagInput label="Labels" bind:tags />
			<SelectField
				label="Status"
				options={STATUS}
				bind:value={status}
				hint="On hold is unavailable here."
			/>
			<div class="flex flex-col gap-1">
				<span class="text-xs font-medium text-muted">Plain select</span>
				<Select label="Plain select" options={STATUS} bind:value={status} />
			</div>
			<DatePickerField label="Due date" bind:value={date} />
			<TimePickerField label="Publish at" bind:value={time} />
			<Checkbox
				label="Notify the team"
				hint="Sends one message when the status changes."
				bind:checked
			/>
			<Switch
				label="Agents may set COMPLETED"
				hint="Off keeps closing for people only."
				bind:checked={on}
			/>
			<SegmentedControl
				label="View"
				bind:value={seg}
				options={[
					{ value: 'board', label: 'Board' },
					{ value: 'list', label: 'List' },
					{ value: 'areas', label: 'Areas' }
				]}
			/>
		</div>
	</Card>

	<Card data-testid="g-overlays">
		{#snippet header()}<h2 class="text-lg font-semibold">Overlays</h2>{/snippet}
		<div class="flex flex-wrap items-center gap-3">
			<Button onclick={() => (modal = true)}>Open dialog</Button>
			<Button variant="danger" onclick={() => (confirm = true)}>Delete item</Button>
			<Button onclick={() => (stale = true)}>Stale write</Button>
			<Tooltip text="Opens the item in a new tab">
				{#snippet children({ props })}<Button {...props}>Hover me</Button>{/snippet}
			</Tooltip>
			<Popover bind:open={popover} label="Filters">
				{#snippet trigger({ props, toggle })}<Button {...props} onclick={toggle}>Filters</Button
					>{/snippet}
				<div class="flex w-64 flex-col gap-1 p-2">
					<Checkbox label="Only my items" />
					<Checkbox label="Only running" />
				</div>
			</Popover>
			<ActionMenu
				items={[
					{ label: 'Rename', icon: Pencil, onselect: () => toast.info('Rename chosen') },
					{ label: 'Archive', icon: Archive, onselect: () => toast.success('Archived') },
					{
						label: 'Delete',
						icon: Trash,
						danger: true,
						onselect: () => toast.error('Delete failed, try again')
					}
				]}
			/>
			<Button
				onclick={() =>
					toast.success('Saved', { label: 'Undo', run: () => void toast.info('Undone') })}
				>Success toast</Button
			>
			<Button onclick={() => toast.error('Could not save. The connection dropped.')}
				>Error toast</Button
			>
			<Button
				onclick={() =>
					void toast
						.promise(new Promise((done) => setTimeout(done, 1500)), {
							loading: 'Saving...',
							success: 'Saved.',
							error: 'Could not save.'
						})
						.catch(() => {})}>Promise toast</Button
			>
			<Button
				onclick={() =>
					void toast
						.promise(new Promise((_, refuse) => setTimeout(() => refuse(new Error('no')), 1500)), {
							loading: 'Saving...',
							success: 'Saved.',
							error: 'You are not allowed to do that.'
						})
						.catch(() => {})}>Refused promise toast</Button
			>
		</div>
	</Card>

	<div class="grid gap-6 sm:grid-cols-2" data-testid="g-card-variants">
		<Card
			icon={Settings}
			title="Icon header"
			description="A title, one line, and an icon that says what it is."
		>
			<p class="text-sm text-muted">The body of the card.</p>
			{#snippet footer()}<Button variant="primary">Save</Button>{/snippet}
		</Card>
		<Card tone="danger" icon={Trash} title="Danger zone" description="This cannot be undone.">
			<p class="text-sm text-muted">Removing it deletes everything inside.</p>
			{#snippet footer()}<Button>Remove</Button>{/snippet}
		</Card>
	</div>

	<Card>
		{#snippet header()}<h2 class="text-lg font-semibold">Background treatments</h2>{/snippet}
		<!-- THE THREE LAYERS ALONE AND THE CHOSEN MIX (ADR-024), EACH ON THE PAGE COLOUR WITH TEXT ON TOP SO THE LEGIBILITY IS PLAIN TO SEE -->
		<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="g-textures">
			{#each [{ name: 'Aurora', kinds: ['aurora'] }, { name: 'Grid', kinds: ['grid'] }, { name: 'Paper grain', kinds: ['paper'] }, { name: 'Chosen mix', kinds: ['aurora', 'grid', 'paper'] }] as t (t.name)}
				<div
					class="relative h-40 overflow-hidden rounded-xl border border-line bg-bg p-4"
					data-testid="g-texture"
				>
					<Texture kinds={t.kinds as ('aurora' | 'grid' | 'paper')[]} contained />
					<p class="relative text-sm font-medium text-ink">{t.name}</p>
					<p class="relative mt-1 text-xs text-muted">Body text on the treatment, 13 pixels.</p>
				</div>
			{/each}
		</div>
	</Card>

	<div class="grid gap-6 sm:grid-cols-2" data-testid="g-states">
		<Card>
			{#snippet header()}<h2 class="text-lg font-semibold">Loading</h2>{/snippet}
			<Skeleton lines={4} />
		</Card>
		<Card>
			{#snippet header()}<h2 class="text-lg font-semibold">Empty</h2>{/snippet}
			<EmptyState
				title="No items yet"
				text="Items appear here once an agent or a person creates one. Start by adding the first."
			>
				{#snippet action()}<Button variant="primary">New item</Button>{/snippet}
			</EmptyState>
		</Card>
		<Card>
			{#snippet header()}<h2 class="text-lg font-semibold">Error</h2>{/snippet}
			<ErrorState
				message="The registry did not load. The server answered with an error."
				onretry={() => new Promise((r) => setTimeout(r, 600))}
			/>
		</Card>
		<Card>
			{#snippet header()}<h2 class="text-lg font-semibold">Permission denied</h2>{/snippet}
			<PermissionDenied needed="Admin" current="Member" what="Organisation settings" />
		</Card>
	</div>
	<Card padded={false} data-testid="g-offline">
		<OfflineBanner liveLost />
		<p class="p-4 text-sm text-muted">The banner above shows when live updates are lost.</p>
	</Card>

	<Card data-testid="g-lists">
		{#snippet header()}<h2 class="text-lg font-semibold">Lists</h2>{/snippet}
		<div class="flex flex-col gap-4">
			<SearchStatus query="cards" count={12} />
			<Pagination bind:page count={20} />
			<VirtualList
				items={ROWS}
				rowHeight={48}
				keyOf={(r) => r.id}
				label="5,000 items"
				class="h-72 rounded-lg border border-line"
			>
				{#snippet row(item)}
					<div data-row class="flex h-full items-center gap-3 border-b border-line px-3 text-sm">
						<span class="font-mono text-xs text-muted tabular-nums">{item.id}</span>
						<span>{item.title}</span>
					</div>
				{/snippet}
			</VirtualList>
		</div>
	</Card>

	<Card data-testid="g-palette">
		{#snippet header()}<h2 class="text-lg font-semibold">Palette generator</h2>{/snippet}
		<div class="flex flex-col gap-4">
			<TextField
				label="Seed colour (hex)"
				bind:value={seed}
				hint="A pale seed is adjusted until every pair passes AA."
			/>
			{#if palette}
				<p class="text-sm" data-testid="palette-adjusted">
					{palette.adjusted
						? 'This seed was adjusted to pass contrast.'
						: 'This seed passes as it is.'}
				</p>
				<div class="grid gap-4 sm:grid-cols-2">
					{#each ['light', 'dark'] as m (m)}
						{@const mode = m === 'light' ? palette.light : palette.dark}
						<div class="flex flex-col gap-2">
							<h3 class="text-sm font-semibold capitalize">{m}</h3>
							<div class="flex flex-wrap gap-2">
								<!-- PALETTE COLOURS ARE RUNTIME VALUES FROM THE GENERATOR -->
								<span
									class="inline-flex h-11 min-w-24 items-center justify-center rounded-lg px-3 text-sm font-medium"
									style="background:{mode.accent};color:{mode.accentInk}">Accent</span
								>
								<span
									class="inline-flex h-11 min-w-24 items-center justify-center rounded-lg px-3 text-sm font-medium"
									style="background:{mode.accentSoft};color:{mode.accentText}">Soft</span
								>
							</div>
						</div>
					{/each}
				</div>
				<table class="w-full text-left text-sm" data-testid="palette-pairs">
					<thead
						><tr class="text-xs text-muted"
							><th class="py-1 font-semibold">Pair</th><th class="py-1 font-semibold">Ratio</th><th
								class="py-1 font-semibold">Needs</th
							><th class="py-1 font-semibold">Result</th></tr
						></thead
					>
					<tbody>
						{#each pairs.filter((x) => !x.name.includes('chart')) as p (p.name)}
							<tr data-row class="border-t border-line"
								><td class="py-1.5">{p.name}</td><td class="font-mono text-xs tabular-nums"
									>{p.ratio}</td
								><td class="font-mono text-xs tabular-nums">{p.need}</td><td
									>{p.pass ? 'Pass' : 'Fail'}</td
								></tr
							>
						{/each}
					</tbody>
				</table>
				<p class="text-sm text-muted" data-testid="palette-charts">
					{pairs.filter((x) => x.name.includes('chart') && x.pass).length} of {pairs.filter((x) =>
						x.name.includes('chart')
					).length} chart colours pass 3:1 on the surface.
				</p>
			{/if}
		</div>
	</Card>
	<Card data-testid="g-visuals">
		{#snippet header()}<h2 class="text-lg font-semibold">Visuals</h2>{/snippet}
		<div class="flex flex-col gap-8">
			<div class="flex flex-wrap items-center gap-6">
				<ProgressRing value={0} label="Ring at zero" size={48} />
				<ProgressRing value={50} label="Ring at half" size={48} />
				<ProgressRing value={100} label="Ring when done" size={48} />
				<ProgressRing value={50} label="Small ring" size={28} />
			</div>
			<PhaseStepper
				phases={[
					{ key: '1', title: 'Foundations', done: 4, total: 4 },
					{ key: '2', title: 'Components', done: 2, total: 5 },
					{ key: '3', title: 'Screens', done: 0, total: 6 }
				]}
			/>
			<div class="flex flex-wrap items-center gap-4">
				<Avatar name="Olivia Owner" size={40} />
				<Avatar name="Claude Code" size={40} kind="agent" />
				<Avatar name="Maria Member" size={32} />
				<Avatar name="Victor Viewer" size={24} />
			</div>
			<div class="flex flex-wrap gap-6">
				{#each ILLUSTRATIONS as k (k)}
					<figure class="flex flex-col items-center gap-2">
						<Illustration kind={k} />
						<figcaption class="text-sm text-muted">{k}</figcaption>
					</figure>
				{/each}
			</div>
		</div>
	</Card>
</PageFrame>

<ResponsiveModal open={modal} onclose={() => (modal = false)} title="Move item to another project">
	<p>The item keeps its number and its history. Anyone watching it is told.</p>
	{#snippet footer()}
		<Button onclick={() => (modal = false)}>Cancel</Button>
		<Button variant="primary" onclick={() => (modal = false)}>Move item</Button>
	{/snippet}
</ResponsiveModal>

<ConfirmDialog
	open={confirm}
	onclose={() => (confirm = false)}
	title="Delete ACME-142?"
	confirmLabel="Delete item"
	tone="danger"
	onconfirm={() => new Promise<void>((r) => setTimeout(r, 500))}
>
	<p>The item moves to the trash for 30 days. You can restore it from there.</p>
</ConfirmDialog>

<StaleWriteDialog
	open={stale}
	onclose={() => (stale = false)}
	changedBy="Claude Code"
	changedAt="09:12"
	onreload={() => (stale = false)}
	oncompare={() => (stale = false)}
/>
