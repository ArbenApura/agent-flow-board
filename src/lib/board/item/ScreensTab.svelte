<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	import type { ItemScreens, ScreenView } from '#lib/server/web/itemScreens.js';
	// IMPORTED ENVS
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	// IMPORTED DEP-MODULES
	import { SvelteMap } from 'svelte/reactivity';
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import ImageOff from '@lucide/svelte/icons/image-off';
	import Maximize from '@lucide/svelte/icons/maximize';
	import PanelRight from '@lucide/svelte/icons/panel-right';
	import Columns2 from '@lucide/svelte/icons/columns-2';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import ZoomIn from '@lucide/svelte/icons/zoom-in';
	import ZoomOut from '@lucide/svelte/icons/zoom-out';

	// -- REQUIRED PROPS -- //

	// The plan is passed like every tab gets it; the screens carry everything this tab shows
	let { env, screens }: { detail: ItemView; env: TabEnv; screens: ItemScreens } = $props();

	// -- TYPES -- //

	type Slot = {
		key: string;
		screen: string;
		mode: 'light' | 'dark';
		width: number;
		before?: ScreenView;
		after?: ScreenView;
	};

	// -- CONSTANTS -- //

	// A very tall full-page capture still fits at this floor
	const MIN_ZOOM = 0.02;
	const MAX_ZOOM = 8;
	// Room kept around the picture when it is fitted: a margin, and the floating toolbar at the bottom
	const FIT_MARGIN = 48;
	const FIT_TOOLBAR = 112;
	const PAN_STEP = 60;

	// -- STATES -- //

	let role = $state<'before' | 'after'>('after');
	let failed = $state<Record<string, boolean>>({});
	// The slot stays here while the modal closes, so its content does not flash blank (the out transition)
	let held = $state<Slot | null>(null);
	let viewport = $state<HTMLElement>();
	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let natural = $state({ w: 900, h: 562 });
	let compare = $state(false);
	let split = $state(0.5);
	let info = $state(true);
	let hint = $state(true);
	// True while a confirmation is open on top of the modal, so the keys do not move the viewer behind it
	let removing = $state(false);
	let prevKey = '';
	// Set when the slot changes, so the next picture that loads is fitted once and a later First or Latest switch keeps the zoom
	let needsFit = false;
	const pointers = new SvelteMap<number, { x: number; y: number }>();
	let pinch = 0;

	// -- REACTIVE STATES -- //

	const list = $derived(screens.list ?? []);
	// One slot for each screen, mode and width, holding its first capture (before) and its latest (after)
	const slots = $derived.by(() => {
		const byKey = new SvelteMap<string, Slot>();
		for (const s of list) {
			const key = `${s.screen}~${s.mode}~${s.width}`;
			const slot = byKey.get(key) ?? { key, screen: s.screen, mode: s.mode, width: s.width };
			if (s.role === 'before') slot.before = s;
			else slot.after = s;
			byKey.set(key, slot);
		}
		return [...byKey.values()];
	});
	const selected = $derived(slots.find((s) => s.key === page.url.searchParams.get('s')) ?? null);
	const slot = $derived(selected ?? held);
	const index = $derived(slot ? slots.findIndex((s) => s.key === slot.key) : -1);
	const both = $derived(Boolean(slot?.before && slot.after));
	const comparing = $derived(compare && both);
	// The picture on show: the latest, or the first one when the person asks for it or there is only that
	const shown = $derived(
		slot
			? role === 'before' && slot.before
				? slot.before
				: (slot.after ?? slot.before ?? null)
			: null
	);
	const percent = $derived(Math.round(zoom * 100));

	// -- REACTIVE STATEMENTS -- //

	// A new screen on show starts with its latest picture, fitted, with the details open on a wide screen
	$effect(() => {
		const s = selected;
		if (!s) {
			// Closed: the same screen opened again starts fresh
			prevKey = '';
			return;
		}
		held = s;
		if (s.key === prevKey) return;
		prevKey = s.key;
		needsFit = true;
		role = 'after';
		compare = false;
		split = 0.5;
		hint = true;
		info = window.innerWidth >= 1024;
	});

	// The wheel zooms around the pointer. The listener is not passive, so the page behind never scrolls with it
	$effect(() => {
		const el = viewport;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const r = el.getBoundingClientRect();
			zoomAt(
				Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)),
				e.clientX - r.left,
				e.clientY - r.top
			);
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => {
			el.removeEventListener('wheel', onWheel);
			// The viewer went away mid gesture, so no finger is left counted
			pointers.clear();
			pinch = 0;
		};
	});

	// -- FUNCTIONS -- //

	const hrefOf = (key: string | null) =>
		key ? `${page.url.pathname}?tab=screens&s=${key}` : `${page.url.pathname}?tab=screens`;
	const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
	const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
	const modeLabel = (m: 'light' | 'dark') => (m === 'dark' ? 'Dark mode' : 'Light mode');

	/** The picture fitted inside the viewer, centred, with room for the toolbar. */
	function fit() {
		if (!viewport) return;
		const r = viewport.getBoundingClientRect();
		if (!r.width) return;
		const aw = r.width - FIT_MARGIN;
		const ah = r.height - FIT_TOOLBAR;
		zoom = clamp(Math.min(aw / natural.w, ah / natural.h), MIN_ZOOM, MAX_ZOOM);
		panX = (r.width - natural.w * zoom) / 2;
		panY = FIT_MARGIN / 2 + (ah - natural.h * zoom) / 2;
	}

	/** Zooms by a factor and keeps the point under (cx, cy) where it is. */
	function zoomAt(factor: number, cx: number, cy: number) {
		const next = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
		panX = cx - ((cx - panX) * next) / zoom;
		panY = cy - ((cy - panY) * next) / zoom;
		zoom = next;
		hint = false;
	}

	function zoomCentre(factor: number) {
		const r = viewport?.getBoundingClientRect();
		if (r) zoomAt(factor, r.width / 2, r.height / 2);
	}

	function actualSize() {
		zoomCentre(1 / zoom);
	}

	function toggleInfo() {
		info = !info;
		// The viewer changed width, so the picture is fitted again once the panel has moved
		queueMicrotask(fit);
	}

	function onImageLoad(e: Event) {
		const img = e.currentTarget as HTMLImageElement;
		const same =
			!img.naturalWidth || (natural.w === img.naturalWidth && natural.h === img.naturalHeight);
		if (!same) natural = { w: img.naturalWidth, h: img.naturalHeight };
		// Fitted for a new screen or a new picture size only, so switching First and Latest keeps the person's zoom and place
		if (needsFit || !same) {
			needsFit = false;
			queueMicrotask(fit);
		}
	}

	function pointerDown(e: PointerEvent) {
		if ((e.target as HTMLElement).closest('[data-viewer-ui]')) return;
		// Only the main button drags: a right click opens a menu and may never send its pointer up
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		viewport?.setPointerCapture(e.pointerId);
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		hint = false;
		if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			pinch = Math.hypot(a.x - b.x, a.y - b.y);
		}
	}

	function pointerMove(e: PointerEvent) {
		const prev = pointers.get(e.pointerId);
		if (!prev || !viewport) return;
		const r = viewport.getBoundingClientRect();
		pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.size === 2) {
			const [a, b] = [...pointers.values()];
			const d = Math.hypot(a.x - b.x, a.y - b.y);
			if (pinch) zoomAt(d / pinch, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
			pinch = d;
			return;
		}
		panX += e.clientX - prev.x;
		panY += e.clientY - prev.y;
	}

	function pointerUp(e: PointerEvent) {
		pointers.delete(e.pointerId);
		pinch = 0;
	}

	/** Double click toggles between fitted and actual size at the pointer. */
	function doubleClick(e: MouseEvent) {
		if ((e.target as HTMLElement).closest('[data-viewer-ui]') || !viewport) return;
		const r = viewport.getBoundingClientRect();
		const fitted = clamp(
			Math.min((r.width - FIT_MARGIN) / natural.w, (r.height - FIT_TOOLBAR) / natural.h),
			MIN_ZOOM,
			MAX_ZOOM
		);
		if (Math.abs(zoom - fitted) < 0.02) zoomAt(1 / zoom, e.clientX - r.left, e.clientY - r.top);
		else fit();
	}

	/** Moves the compare divider with the pointer; its place is a fraction of the picture. */
	function dragSplit(e: PointerEvent) {
		e.stopPropagation();
		const grip = e.currentTarget as HTMLElement;
		grip.setPointerCapture(e.pointerId);
		const move = (ev: PointerEvent) => {
			if (!viewport) return;
			const r = viewport.getBoundingClientRect();
			split = clamp((ev.clientX - r.left - panX) / (natural.w * zoom), 0, 1);
		};
		const up = () => {
			grip.removeEventListener('pointermove', move);
			grip.removeEventListener('pointerup', up);
			grip.removeEventListener('pointercancel', up);
			grip.removeEventListener('lostpointercapture', up);
		};
		grip.addEventListener('pointermove', move);
		grip.addEventListener('pointerup', up);
		grip.addEventListener('pointercancel', up);
		grip.addEventListener('lostpointercapture', up);
	}

	function step(delta: number) {
		const next = slots[index + delta];
		if (next) goto(hrefOf(next.key), { reset: false });
	}

	function close() {
		goto(hrefOf(null), { reset: false });
	}

	/** Keys inside the open modal: arrows step, plus and minus zoom, 0 fits, 1 shows actual size, Shift and arrows pan. */
	function onKey(e: KeyboardEvent) {
		if (!selected || removing || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
		const target = e.target as HTMLElement;
		// A focused control that uses the arrow keys itself (the capture switch, the divider) keeps them
		if (
			target.isContentEditable ||
			target.closest('input, textarea, select, [role=radiogroup], [data-viewer-ui]')
		)
			return;
		if (e.shiftKey && e.key.startsWith('Arrow')) {
			e.preventDefault();
			panX += e.key === 'ArrowLeft' ? PAN_STEP : e.key === 'ArrowRight' ? -PAN_STEP : 0;
			panY += e.key === 'ArrowUp' ? PAN_STEP : e.key === 'ArrowDown' ? -PAN_STEP : 0;
		} else if (e.key === 'ArrowLeft') step(-1);
		else if (e.key === 'ArrowRight') step(1);
		else if (e.key === '+' || e.key === '=') zoomCentre(1.25);
		else if (e.key === '-') zoomCentre(0.8);
		else if (e.key === '0') fit();
		else if (e.key === '1') actualSize();
	}

	async function removeShot() {
		const s = shown;
		const current = slot;
		if (!s || !current) return;
		removing = true;
		const yes = await askConfirm({
			title: 'Remove this screenshot?',
			body: 'The picture is deleted for everyone who can see this plan. The agent can add a new capture.',
			confirmLabel: 'Remove screenshot',
			tone: 'danger'
		}).finally(() => (removing = false));
		if (!yes) return;
		try {
			await api(env.org, `/screens/${s.id}`, { method: 'DELETE', key: newKey() });
			await env.onchanged();
			// Nothing left of this slot shows the viewer's place, so the page goes back to the gallery
			if (
				!list.some(
					(x) =>
						x.id !== s.id &&
						x.screen === current.screen &&
						x.mode === current.mode &&
						x.width === current.width
				)
			)
				await goto(hrefOf(null), { invalidateAll: true, reset: false });
		} catch (e) {
			toast.error(message(e, 'The screenshot was not removed.'));
		}
	}
</script>

<!-- A resize or a phone turn fits the picture again while the modal is open -->
<svelte:window
	onkeydown={onKey}
	onresize={() => {
		if (selected) fit();
	}}
/>

<!-- THE SCREENS TAB OF A PLAN: ONE GALLERY OF LARGE CARDS, THE DETAILS IN A MODAL WITH A PANNABLE AND ZOOMABLE PICTURE (AFB-20261125-0625) -->
<div class="flex flex-col gap-4" data-testid="screens-tab">
	{#if slots.length === 0}
		<div class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]">
			<EmptyState
				kind="files"
				title="No screenshots yet"
				text="The agent adds the finished screens here at the end of a plan, in light and dark at desktop and phone width."
			/>
		</div>
	{:else}
		<!-- ONE CARD FOR EACH SCREEN, MODE AND WIDTH. EACH IS A LINK, SO THE ADDRESS AND THE BACK BUTTON FOLLOW THE CHOICE -->
		<ul class="grid [grid-template-columns:repeat(auto-fill,minmax(min(100%,460px),1fr))] gap-4">
			{#each slots as s (s.key)}
				{@const cover = s.after ?? s.before}
				<li>
					<a
						href={hrefOf(s.key)}
						data-sveltekit-noscroll
						class="group flex h-full cursor-pointer flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--elev-1)] hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
					>
						<span class="block aspect-[16/10] overflow-hidden border-b border-line bg-raised">
							{#if cover && !failed[cover.id]}
								<img
									src={cover.image}
									alt=""
									loading="lazy"
									class={cn(
										'size-full transition-transform duration-200 ease-out group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100',
										s.width < 600 ? 'object-contain' : 'object-cover object-top'
									)}
									onerror={() => (failed[cover.id] = true)}
								/>
							{:else}
								<span
									class="flex size-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted"
								>
									<ImageOff size={28} aria-hidden="true" />
									Picture missing
								</span>
							{/if}
						</span>
						<span class="flex flex-col gap-2 p-4 max-sm:p-3.5">
							<span class="flex flex-wrap items-center gap-x-2 gap-y-1">
								<span class="font-mono text-sm font-semibold text-ink">{s.screen}</span>
								<Badge>{s.mode === 'dark' ? 'Dark' : 'Light'}</Badge>
								<span class="text-xs text-muted [font-variant-numeric:tabular-nums]"
									>{s.width} px</span
								>
								{#if s.before && s.after}<span class="text-xs text-muted">First and latest</span
									>{/if}
							</span>
							{#if cover?.caption}
								<!-- WRITTEN BY THE AGENT OR A PERSON: PLAIN TEXT ONLY -->
								<span class="line-clamp-2 text-sm [overflow-wrap:anywhere] text-muted"
									>{cover.caption}</span
								>
							{/if}
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<!-- THE DETAIL MODAL. MOUNTED WITH open, NEVER INSIDE AN {#if}, AND IT KEEPS ITS SLOT WHILE IT CLOSES -->
<ResponsiveModal
	open={selected !== null}
	onclose={close}
	title={slot ? `${slot.screen}, ${modeLabel(slot.mode)}, ${slot.width} px wide` : 'Screenshot'}
	size="full"
	flush
>
	{#snippet heading()}
		{#if slot}
			<span class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
				<span class="truncate font-mono text-base">{slot.screen}</span>
				<Badge>{modeLabel(slot.mode)}</Badge>
				<Badge>{slot.width} px wide</Badge>
			</span>
		{/if}
	{/snippet}

	{#if slot && shown}
		<!-- THE VIEWER. DRAG TO PAN, SCROLL OR PINCH TO ZOOM. THE CANVAS TRANSFORM IS A RUNTIME COORDINATE -->
		<div
			bind:this={viewport}
			role="application"
			aria-label="Screenshot viewer. Drag to pan, scroll to zoom, plus and minus to zoom, 0 to fit, 1 for actual size."
			class="relative min-w-0 flex-1 cursor-grab touch-none overflow-hidden bg-raised select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent active:cursor-grabbing"
			data-testid="screen-viewer"
			onpointerdown={pointerDown}
			onpointermove={pointerMove}
			onpointerup={pointerUp}
			onpointercancel={pointerUp}
			ondblclick={doubleClick}
		>
			{#if failed[shown.id]}
				<div class="grid size-full place-items-center p-6" data-viewer-ui>
					<Notice tone="warning">
						The picture is missing. It may not have come back with a restore; the agent adds it
						again at the end of the next plan.
					</Notice>
				</div>
			{:else}
				<!-- THE CANVAS IS THE PICTURE'S OWN SIZE, MOVED AND SCALED WITH ONE TRANSFORM -->
				<div
					class="absolute top-0 left-0 origin-top-left overflow-hidden rounded-sm border border-line shadow-[var(--elev-2)]"
					style="width: {natural.w}px; height: {natural.h}px; transform: translate({panX}px, {panY}px) scale({zoom});"
				>
					<img
						src={comparing ? (slot.after?.image ?? shown.image) : shown.image}
						alt={`${slot.screen}, ${slot.mode} mode, ${slot.width} pixels wide, ${comparing ? 'latest' : shown.role === 'before' ? 'first' : 'latest'} capture`}
						class="absolute inset-0 size-full max-w-none"
						draggable="false"
						onload={onImageLoad}
						onerror={() => (failed[shown.id] = true)}
					/>
					{#if comparing && slot.before}
						<!-- THE FIRST CAPTURE ON TOP, CUT AT THE DIVIDER. THE CUT IS A RUNTIME PERCENT -->
						<img
							src={slot.before.image}
							alt={`${slot.screen}, first capture`}
							class="absolute inset-0 size-full max-w-none"
							draggable="false"
							style="clip-path: inset(0 {(1 - split) * 100}% 0 0);"
						/>
					{/if}
				</div>

				{#if comparing}
					<!-- THE COMPARE DIVIDER: LEFT OF IT IS THE FIRST CAPTURE, RIGHT OF IT THE LATEST. ITS PLACE FOLLOWS THE PICTURE -->
					<div
						class="pointer-events-none absolute inset-y-0 w-0"
						style="left: {panX + split * natural.w * zoom}px;"
					>
						<div class="absolute inset-y-0 -left-px w-0.5 bg-accent"></div>
						<button
							type="button"
							data-viewer-ui
							aria-label="Move the compare divider"
							class="pointer-events-auto absolute top-1/2 grid size-11 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize place-items-center rounded-full border-2 border-accent bg-surface text-accent-text shadow-[var(--elev-2)]"
							onpointerdown={dragSplit}
							onkeydown={(e) => {
								if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
								// The divider uses the arrow keys itself, so the screen does not change with it
								e.preventDefault();
								e.stopPropagation();
								split = clamp(split + (e.key === 'ArrowLeft' ? -0.02 : 0.02), 0, 1);
							}}
						>
							<ChevronLeft size={16} aria-hidden="true" class="-mr-1.5" />
							<ChevronRight size={16} aria-hidden="true" class="-ml-1.5" />
						</button>
						<span
							class="absolute top-3 right-full mr-3 rounded-full bg-surface px-2.5 py-0.5 text-badge font-semibold whitespace-nowrap text-ink shadow-[var(--elev-1)]"
							>First</span
						>
						<span
							class="absolute top-3 left-full ml-3 rounded-full bg-surface px-2.5 py-0.5 text-badge font-semibold whitespace-nowrap text-ink shadow-[var(--elev-1)]"
							>Latest</span
						>
					</div>
				{/if}
			{/if}

			<!-- THE VIEWER TOOLBAR, FLOATING AT THE BOTTOM CENTRE -->
			<div class="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-3">
				<div
					role="toolbar"
					aria-label="Zoom"
					data-viewer-ui
					class="pointer-events-auto flex max-w-full [scrollbar-width:none]! items-center gap-1 overflow-x-auto overflow-y-hidden rounded-xl border border-line bg-surface p-1 shadow-[var(--elev-2)] [&::-webkit-scrollbar]:hidden"
				>
					<Button variant="subtle" iconOnly aria-label="Zoom out" onclick={() => zoomCentre(0.8)}>
						<ZoomOut size={18} aria-hidden="true" />
					</Button>
					<span
						class="min-w-14 shrink-0 text-center text-sm font-medium [font-variant-numeric:tabular-nums]"
						>{percent}%</span
					>
					<Button variant="subtle" iconOnly aria-label="Zoom in" onclick={() => zoomCentre(1.25)}>
						<ZoomIn size={18} aria-hidden="true" />
					</Button>
					<span class="mx-1 h-6 w-px shrink-0 bg-line max-sm:hidden" aria-hidden="true"></span>
					<Button variant="subtle" class="max-sm:min-w-11 max-sm:px-0" onclick={fit}>
						<Maximize size={16} aria-hidden="true" />
						<span class="max-sm:sr-only">Fit</span>
					</Button>
					<Button variant="subtle" class="max-sm:min-w-11 max-sm:px-0" onclick={actualSize}
						>100%</Button
					>
					{#if both}
						<span class="mx-1 h-6 w-px shrink-0 bg-line max-sm:hidden" aria-hidden="true"></span>
						<Button
							variant="subtle"
							aria-pressed={compare}
							class="aria-pressed:bg-accent-soft aria-pressed:text-accent-text max-sm:min-w-11 max-sm:px-0"
							onclick={() => (compare = !compare)}
						>
							<Columns2 size={16} aria-hidden="true" />
							<span class="max-sm:sr-only">Compare</span>
						</Button>
					{/if}
					<Button
						variant="subtle"
						aria-pressed={info}
						class="aria-pressed:bg-accent-soft aria-pressed:text-accent-text max-sm:min-w-11 max-sm:px-0"
						onclick={toggleInfo}
					>
						<PanelRight size={16} aria-hidden="true" />
						<span class="max-sm:sr-only">Details</span>
					</Button>
				</div>
			</div>

			<!-- A QUIET HINT, GONE AFTER THE FIRST MOVE -->
			<p
				class={cn(
					'pointer-events-none absolute top-3 left-3 rounded-full bg-surface px-3 py-1 text-xs text-muted shadow-[var(--elev-1)] transition-opacity duration-300 motion-reduce:transition-none max-sm:hidden',
					hint ? 'opacity-100' : 'opacity-0'
				)}
			>
				Scroll to zoom, drag to pan, double-click to fit
			</p>
		</div>

		<!-- THE DETAILS: A SIDE PANEL FROM lg UP, A SHEET OVER THE BOTTOM OF THE VIEWER BELOW IT. THE TEXT WAS WRITTEN BY SOMEONE ELSE, SO IT IS PLAIN TEXT ONLY -->
		{#if info}
			<aside
				aria-label="Details"
				class="flex min-w-0 flex-col gap-4 overflow-auto border-line bg-surface p-5 max-lg:absolute max-lg:inset-x-0 max-lg:bottom-0 max-lg:max-h-[60%] max-lg:border-t max-lg:p-3.5 max-lg:pb-20 max-lg:shadow-[var(--shadow-pop)] lg:w-80 lg:shrink-0 lg:border-l"
			>
				<section class="flex flex-col gap-1.5">
					<h3 class="text-base font-semibold">What it shows</h3>
					<p class="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">
						{shown.caption || 'No caption was written for this picture.'}
					</p>
				</section>
				{#if shown.note}
					<section class="flex flex-col gap-1.5">
						<h3 class="text-base font-semibold">Notes</h3>
						<p class="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-muted">
							{shown.note}
						</p>
					</section>
				{/if}
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-line pt-4 text-sm">
					<dt class="text-muted">Mode</dt>
					<dd>{slot.mode === 'dark' ? 'Dark' : 'Light'}</dd>
					<dt class="text-muted">Width</dt>
					<dd class="[font-variant-numeric:tabular-nums]">{slot.width} px</dd>
					<dt class="text-muted">Capture</dt>
					<dd>
						{comparing
							? 'First and latest'
							: shown.role === 'before'
								? 'First capture'
								: 'Latest capture'}
					</dd>
					<dt class="text-muted">Captured</dt>
					<dd>{ago(shown.createdAt)}</dd>
				</dl>
				<p class="border-t border-line pt-4 text-xs text-muted">
					Keys: arrows for previous and next, plus and minus to zoom, 0 to fit, 1 for actual size,
					Shift and arrows to pan.
				</p>
			</aside>
		{/if}
	{/if}

	{#snippet footer()}
		<div class="flex w-full flex-wrap items-center gap-2">
			<div class="flex items-center gap-2">
				<Button
					iconOnly
					aria-label="Previous screen"
					disabled={index <= 0}
					onclick={() => step(-1)}
				>
					<ChevronLeft size={16} aria-hidden="true" />
				</Button>
				<span class="min-w-14 text-center text-sm text-muted [font-variant-numeric:tabular-nums]"
					>{index + 1} of {slots.length}</span
				>
				<Button
					iconOnly
					aria-label="Next screen"
					disabled={index < 0 || index >= slots.length - 1}
					onclick={() => step(1)}
				>
					<ChevronRight size={16} aria-hidden="true" />
				</Button>
			</div>
			<div
				class="ml-auto flex flex-wrap items-center justify-end gap-2 max-sm:ml-0 max-sm:w-full max-sm:justify-between"
			>
				{#if both && !comparing}
					<SegmentedControl
						label="Which capture"
						value={role}
						options={[
							{ value: 'after', label: 'Latest' },
							{ value: 'before', label: 'First' }
						]}
						onchange={(v) => (role = v === 'before' ? 'before' : 'after')}
					/>
				{/if}
				{#if env.canWrite}
					<Button variant="ghost" tone="danger" onclick={removeShot} data-testid="remove-screen">
						<Trash2 size={16} aria-hidden="true" /> Remove
					</Button>
				{/if}
				<Button variant="primary" onclick={close}>Close</Button>
			</div>
		</div>
	{/snippet}
</ResponsiveModal>
