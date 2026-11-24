<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	import type { ItemScreens, ScreenView } from '#lib/server/web/itemScreens.js';
	// IMPORTED ENVS
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	// IMPORTED MODULES
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import Check from '@lucide/svelte/icons/check';
	import MoveUpRight from '@lucide/svelte/icons/move-up-right';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Square from '@lucide/svelte/icons/square';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import MapPin from '@lucide/svelte/icons/map-pin';

	// -- REQUIRED PROPS -- //

	// The plan is passed like every tab gets it; the screens carry everything this tab shows
	let { env, screens }: { detail: ItemView; env: TabEnv; screens: ItemScreens } = $props();

	// -- TYPES -- //

	type Note = ScreenView['annotations'][number];
	type Kind = 'pin' | 'box' | 'arrow';
	type Slot = {
		key: string;
		screen: string;
		mode: 'light' | 'dark';
		width: number;
		before?: ScreenView;
		after?: ScreenView;
	};
	/** A shape being drawn: fractions of the picture, 0 to 1. A box has a positive size, an arrow's size is where it ends. */
	type Draft = { kind: Kind; x: number; y: number; w: number; h: number };

	// -- CONSTANTS -- //

	const KINDS: { value: Kind; label: string; icon: typeof MapPin }[] = [
		{ value: 'pin', label: 'Pin', icon: MapPin },
		{ value: 'box', label: 'Box', icon: Square },
		{ value: 'arrow', label: 'Arrow', icon: MoveUpRight }
	];
	const MIN_BOX = 0.01;

	// -- STATES -- //

	let role = $state<'before' | 'after'>('after');
	let tool = $state<Kind | null>(null);
	let draft = $state<Draft | null>(null);
	let start = $state<{ x: number; y: number } | null>(null);
	let text = $state('');
	let busy = $state(false);
	let activeNote = $state<string | null>(null);
	let failed = $state<Record<string, boolean>>({});
	let overlay = $state<HTMLElement>();
	let prevSelected = '';

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
	const groups = $derived.by(() => {
		const byScreen = new SvelteMap<string, Slot[]>();
		for (const s of slots) byScreen.set(s.screen, [...(byScreen.get(s.screen) ?? []), s]);
		return [...byScreen.entries()].map(([screen, items]) => ({ screen, items }));
	});
	const selected = $derived(slots.find((s) => s.key === page.url.searchParams.get('s')) ?? null);
	// The picture on show: the latest, or the first one when the person asks for it or there is only that
	const shown = $derived(
		selected
			? role === 'before' && selected.before
				? selected.before
				: (selected.after ?? selected.before ?? null)
			: null
	);
	const notes = $derived(shown?.annotations ?? []);
	const canWrite = $derived(env.canWrite);

	// -- REACTIVE STATEMENTS -- //

	// A new screen on show starts with its latest picture and no half drawn note
	$effect(() => {
		const key = selected?.key ?? '';
		if (key === prevSelected) return;
		prevSelected = key;
		untrack(() => {
			role = 'after';
			cancel();
			activeNote = null;
		});
	});

	// -- FUNCTIONS -- //

	const hrefOf = (key: string | null) =>
		key ? `${page.url.pathname}?tab=screens&s=${key}` : `${page.url.pathname}?tab=screens`;
	const openCount = (s: Slot) =>
		[s.before, s.after].reduce(
			(n, v) => n + (v?.annotations.filter((a) => !a.resolved).length ?? 0),
			0
		);
	const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
	const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

	/** Keeps a shape inside the picture, whatever moved or grew. */
	function fit(d: Draft): Draft {
		if (d.kind === 'pin') return { ...d, x: clamp(d.x), y: clamp(d.y), w: 0, h: 0 };
		if (d.kind === 'box') {
			const w = clamp(d.w, MIN_BOX, 1);
			const h = clamp(d.h, MIN_BOX, 1);
			return { ...d, w, h, x: clamp(d.x, 0, 1 - w), y: clamp(d.y, 0, 1 - h) };
		}
		const w = clamp(d.w, -1, 1);
		const h = clamp(d.h, -1, 1);
		return {
			...d,
			w,
			h,
			x: clamp(d.x, Math.max(0, -w), Math.min(1, 1 - w)),
			y: clamp(d.y, Math.max(0, -h), Math.min(1, 1 - h))
		};
	}

	/** Where a pointer is on the rendered picture, as fractions of it. The overlay is exactly as big as the picture. */
	function at(e: PointerEvent) {
		const r = overlay!.getBoundingClientRect();
		return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
	}

	function cancel() {
		draft = null;
		tool = null;
		start = null;
		text = '';
	}

	function pointerDown(e: PointerEvent) {
		if (!tool || !canWrite || busy) return;
		e.preventDefault();
		const p = at(e);
		if (tool === 'pin') {
			draft = { kind: 'pin', x: p.x, y: p.y, w: 0, h: 0 };
			tool = null;
			return;
		}
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		start = p;
		draft = { kind: tool, x: p.x, y: p.y, w: 0, h: 0 };
	}

	function pointerMove(e: PointerEvent) {
		if (!start || !draft) return;
		const p = at(e);
		draft =
			draft.kind === 'box'
				? {
						kind: 'box',
						x: Math.min(start.x, p.x),
						y: Math.min(start.y, p.y),
						w: Math.abs(p.x - start.x),
						h: Math.abs(p.y - start.y)
					}
				: { kind: 'arrow', x: start.x, y: start.y, w: p.x - start.x, h: p.y - start.y };
	}

	function pointerUp() {
		if (!start || !draft) return;
		start = null;
		tool = null;
		// A click with no drag draws nothing
		if (
			(draft.kind === 'box' && (draft.w < MIN_BOX || draft.h < MIN_BOX)) ||
			(draft.kind === 'arrow' && Math.hypot(draft.w, draft.h) < MIN_BOX)
		)
			draft = null;
	}

	/** The way in without a mouse: a shape at the middle of the picture, moved and sized with the arrow keys. */
	function placeAtCentre() {
		const kind = tool ?? 'pin';
		draft =
			kind === 'pin'
				? { kind, x: 0.5, y: 0.5, w: 0, h: 0 }
				: kind === 'box'
					? { kind, x: 0.4, y: 0.4, w: 0.2, h: 0.2 }
					: { kind, x: 0.3, y: 0.5, w: 0.4, h: 0 };
		tool = null;
	}

	/** Arrow keys move the shape, Alt with an arrow key changes its size, Shift takes bigger steps. */
	function draftKey(e: KeyboardEvent) {
		if (!draft) return;
		const step = e.shiftKey ? 0.05 : 0.01;
		const move: Record<string, [number, number]> = {
			ArrowLeft: [-step, 0],
			ArrowRight: [step, 0],
			ArrowUp: [0, -step],
			ArrowDown: [0, step]
		};
		const m = move[e.key];
		if (!m) return;
		e.preventDefault();
		draft = fit(
			e.altKey && draft.kind !== 'pin'
				? { ...draft, w: draft.w + m[0], h: draft.h + m[1] }
				: { ...draft, x: draft.x + m[0], y: draft.y + m[1] }
		);
	}

	async function saveNote() {
		if (!draft || !shown || !text.trim() || busy) return;
		busy = true;
		try {
			await api(env.org, '/screen-annotations', {
				method: 'POST',
				key: newKey(),
				body: {
					screen: shown.id,
					kind: draft.kind,
					x: draft.x,
					y: draft.y,
					...(draft.kind === 'pin' ? {} : { w: draft.w, h: draft.h }),
					body: text.trim()
				}
			});
			cancel();
			await env.onchanged();
		} catch (e) {
			toast.error(message(e, 'The note was not saved.'));
		} finally {
			busy = false;
		}
	}

	async function resolve(n: Note) {
		try {
			await api(env.org, `/screen-annotations/${n.id}/resolve`, {
				method: 'POST',
				key: newKey(),
				body: { resolved: !n.resolved }
			});
			await env.onchanged();
		} catch (e) {
			toast.error(message(e, 'The note was not changed.'));
		}
	}

	async function removeNote(n: Note) {
		const yes = await askConfirm({
			title: 'Remove this note?',
			body: 'The note is deleted for everyone who can see this plan. The picture stays.',
			confirmLabel: 'Remove note',
			tone: 'danger'
		});
		if (!yes) return;
		try {
			await api(env.org, `/screen-annotations/${n.id}`, { method: 'DELETE', key: newKey() });
			await env.onchanged();
		} catch (e) {
			toast.error(message(e, 'The note was not removed.'));
		}
	}

	async function removeShot() {
		const s = shown;
		if (!s) return;
		const yes = await askConfirm({
			title: 'Remove this screenshot?',
			body: 'The picture and every note on it are deleted for everyone who can see this plan. The agent can add a new capture.',
			confirmLabel: 'Remove screenshot',
			tone: 'danger'
		});
		if (!yes) return;
		try {
			await api(env.org, `/screens/${s.id}`, { method: 'DELETE', key: newKey() });
			await env.onchanged();
			// Nothing left of this slot shows the viewer's place, so the page goes back to the grid
			if (
				!list.some(
					(x) => x.id !== s.id && x.screen === s.screen && x.mode === s.mode && x.width === s.width
				)
			)
				await goto(hrefOf(null), { invalidateAll: true });
		} catch (e) {
			toast.error(message(e, 'The screenshot was not removed.'));
		}
	}
</script>

<svelte:window
	onkeydown={(e) => {
		// Escape in the note field only leaves the field's own work alone: a half written note is never thrown away by it
		if (e.key === 'Escape' && (draft || tool) && !(e.target instanceof HTMLTextAreaElement))
			cancel();
	}}
/>

<!-- THE SCREENS TAB OF A PLAN: THE FINISHED SCREENS THE AGENT CAPTURED AT THE END OF THE PLAN, FIRST AND LATEST, WITH NOTES DRAWN OVER THEM (AFB-20261124-0926) -->
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
		{#if selected && shown}
			<TabCard title={selected.screen} stack>
				{#snippet meta()}
					<span class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
						<Badge>{selected.mode === 'dark' ? 'Dark mode' : 'Light mode'}</Badge>
						<Badge>{selected.width} px wide</Badge>
						<span class="text-xs text-muted">Captured {ago(shown.createdAt)}</span>
					</span>
				{/snippet}
				{#snippet actions()}
					{#if selected.before && selected.after}
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
					{#if canWrite}
						<Button tone="danger" onclick={removeShot} data-testid="remove-screen">
							<Trash2 size={16} aria-hidden="true" /> Remove
						</Button>
					{/if}
					<Button href={hrefOf(null)} data-sveltekit-noscroll>
						<X size={16} aria-hidden="true" /> Close
					</Button>
				{/snippet}

				<div class="grid gap-4 p-4 max-sm:p-3.5 lg:grid-cols-[minmax(0,1fr)_320px]">
					<div class="flex min-w-0 flex-col gap-3">
						{#if shown.caption}
							<!-- WRITTEN BY THE AGENT OR A PERSON: PLAIN TEXT ONLY -->
							<p class="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">
								{shown.caption}
							</p>
						{/if}
						{#if shown.note}
							<p class="text-xs [overflow-wrap:anywhere] whitespace-pre-wrap text-muted">
								{shown.note}
							</p>
						{/if}

						{#if canWrite}
							<!-- DRAW A NOTE: PICK A SHAPE THEN DRAG ON THE PICTURE, OR PLACE ONE AT THE MIDDLE AND MOVE IT WITH THE ARROW KEYS -->
							<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Add a note">
								{#each KINDS as k (k.value)}
									<Button
										variant={tool === k.value ? 'ghost' : 'secondary'}
										aria-pressed={tool === k.value}
										onclick={() => {
											draft = null;
											tool = tool === k.value ? null : k.value;
										}}
										data-testid={`tool-${k.value}`}
									>
										<k.icon size={16} aria-hidden="true" />
										{k.label}
									</Button>
								{/each}
								{#if tool}
									<Button variant="ghost" onclick={placeAtCentre}>Place at the middle</Button>
								{/if}
								{#if tool || draft}
									<span class="text-xs text-muted">
										{tool
											? (tool === 'pin' ? 'Click' : 'Drag') + ' on the picture, or place one and '
											: ''}Use the arrow keys on the new note to move it (Alt and an arrow key
										changes its size).
									</span>
								{/if}
							</div>
						{/if}

						{#if failed[shown.id]}
							<Notice tone="warning">
								The picture is missing. It may not have come back with a restore; the agent adds it
								again at the end of the next plan.
							</Notice>
						{:else}
							<!-- THE WRAPPER IS EXACTLY THE SIZE OF THE RENDERED PICTURE, SO THE NOTES STAY ON THEIR PLACE AT EVERY WIDTH -->
							<div class="relative w-fit max-w-full leading-[0]" data-testid="screen-stage">
								<img
									src={shown.image}
									alt={`${selected.screen}, ${selected.mode} mode, ${selected.width} pixels wide, ${shown.role === 'before' ? 'first' : 'latest'} capture`}
									class="block h-auto max-w-full rounded-lg border border-line"
									loading="lazy"
									onerror={() => (failed[shown.id] = true)}
								/>
								<div
									bind:this={overlay}
									role="presentation"
									class={cn(
										'absolute inset-0',
										// Touch scrolling is off only while a shape is being drawn, so the picture still scrolls on a phone
										tool || start ? 'cursor-crosshair touch-none' : '',
										busy ? 'pointer-events-none' : ''
									)}
									onpointerdown={pointerDown}
									onpointermove={pointerMove}
									onpointerup={pointerUp}
									onpointercancel={pointerUp}
								>
									<svg
										class="pointer-events-none absolute inset-0 size-full"
										viewBox="0 0 1 1"
										preserveAspectRatio="none"
										aria-hidden="true"
									>
										{#each notes as n (n.id)}
											{#if n.kind === 'box'}
												<rect
													x={n.x}
													y={n.y}
													width={n.w ?? 0}
													height={n.h ?? 0}
													stroke-width="2"
													class={cn(
														'fill-transparent [vector-effect:non-scaling-stroke]',
														n.resolved ? 'stroke-muted' : 'stroke-accent'
													)}
												/>
											{:else if n.kind === 'arrow'}
												<line
													x1={n.x}
													y1={n.y}
													x2={n.x + (n.w ?? 0)}
													y2={n.y + (n.h ?? 0)}
													stroke-width="2"
													class={cn(
														'[vector-effect:non-scaling-stroke]',
														n.resolved ? 'stroke-muted' : 'stroke-accent'
													)}
												/>
											{/if}
										{/each}
										{#if draft}
											{#if draft.kind === 'box'}
												<rect
													x={draft.x}
													y={draft.y}
													width={draft.w}
													height={draft.h}
													stroke-width="2"
													stroke-dasharray="6 4"
													class="fill-accent/10 stroke-accent [vector-effect:non-scaling-stroke]"
												/>
											{:else if draft.kind === 'arrow'}
												<line
													x1={draft.x}
													y1={draft.y}
													x2={draft.x + draft.w}
													y2={draft.y + draft.h}
													stroke-width="2"
													stroke-dasharray="6 4"
													class="stroke-accent [vector-effect:non-scaling-stroke]"
												/>
											{/if}
										{/if}
									</svg>

									<!-- THE END OF AN ARROW IS A DOT. ITS PLACE IS A RUNTIME PERCENT OF THE PICTURE -->
									{#each notes as n (n.id)}
										{#if n.kind === 'arrow'}
											<span
												class={cn(
													'pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full',
													n.resolved ? 'bg-muted' : 'bg-accent'
												)}
												style="left: {(n.x + (n.w ?? 0)) * 100}%; top: {(n.y + (n.h ?? 0)) * 100}%;"
											></span>
										{/if}
									{/each}

									<!-- THE NUMBERED MARKER OF EACH NOTE. THE HIT AREA IS 44 PX, THE MARKER ITSELF 26. ITS PLACE IS A RUNTIME PERCENT OF THE PICTURE -->
									{#each notes as n, i (n.id)}
										<button
											type="button"
											class="absolute grid size-11 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center leading-none focus-visible:outline-none"
											style="left: {n.x * 100}%; top: {n.y * 100}%;"
											aria-label={`Note ${i + 1}${n.resolved ? ' (done)' : ''}`}
											aria-pressed={activeNote === n.id}
											onpointerdown={(e) => e.stopPropagation()}
											onclick={() => (activeNote = activeNote === n.id ? null : n.id)}
										>
											<span
												class={cn(
													'grid size-[26px] place-items-center rounded-full border-2 text-xs font-semibold [font-variant-numeric:tabular-nums]',
													n.resolved
														? 'border-muted bg-surface text-muted'
														: 'border-accent bg-accent text-accent-ink',
													activeNote === n.id ? 'ring-4 ring-accent-soft' : ''
												)}>{i + 1}</span
											>
										</button>
									{/each}

									{#if draft}
										<!-- THE NOTE BEING WRITTEN. IT TAKES THE KEYBOARD: ARROW KEYS MOVE IT, ALT AND AN ARROW KEY SIZES IT. ITS PLACE IS A RUNTIME PERCENT OF THE PICTURE -->
										<button
											type="button"
											class="absolute grid size-11 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center leading-none focus-visible:outline-none"
											style="left: {draft.x * 100}%; top: {draft.y * 100}%;"
											aria-label="The new note. Use the arrow keys to move it."
											onkeydown={draftKey}
											onpointerdown={(e) => e.stopPropagation()}
										>
											<span
												class="grid size-[26px] place-items-center rounded-full border-2 border-accent bg-surface text-xs font-semibold text-accent-text ring-4 ring-accent-soft"
												>{notes.length + 1}</span
											>
										</button>
									{/if}
								</div>
							</div>
						{/if}

						{#if draft}
							<div class="flex flex-col gap-3 rounded-lg border border-line bg-raised p-3">
								<TextArea
									label={`Note ${notes.length + 1}: what should a person look at here?`}
									bind:value={text}
									rows={3}
									maxlength={1000}
									disabled={busy}
								/>
								<div class="flex flex-wrap gap-2">
									<Button
										variant="primary"
										loading={busy}
										disabled={!text.trim() || busy}
										onclick={saveNote}
										data-testid="save-note">Add the note</Button
									>
									<Button variant="ghost" onclick={cancel} disabled={busy}>Cancel</Button>
								</div>
							</div>
						{/if}
					</div>

					<!-- THE NOTES ON THE PICTURE, IN THE ORDER OF THEIR NUMBERS. THE TEXT WAS WRITTEN BY SOMEONE ELSE, SO IT IS PLAIN TEXT ONLY -->
					<section aria-label="Notes on this picture" class="flex min-w-0 flex-col gap-2">
						<h3 class="text-base font-semibold text-ink">Notes</h3>
						{#if notes.length === 0}
							<p class="text-sm text-muted">
								No notes yet.{canWrite ? ' Pick a shape above and mark what to check.' : ''}
							</p>
						{:else}
							<ol class="flex flex-col gap-2">
								{#each notes as n, i (n.id)}
									<li
										class={cn(
											'flex flex-col gap-1.5 rounded-lg border p-3',
											activeNote === n.id
												? 'border-accent bg-accent-soft'
												: 'border-line bg-surface'
										)}
									>
										<div class="flex items-center gap-2">
											<span
												class="grid size-6 shrink-0 place-items-center rounded-full bg-raised text-xs font-semibold text-ink"
												>{i + 1}</span
											>
											<span class="min-w-0 truncate text-xs text-muted"
												>{n.author || 'Someone'}, {ago(n.createdAt)}</span
											>
											{#if n.resolved}<Badge tone="success">Done</Badge>{/if}
										</div>
										<p class="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">
											{n.body}
										</p>
										{#if canWrite}
											<div class="flex gap-2">
												<Button size="sm" onclick={() => resolve(n)}>
													{#if n.resolved}<RotateCcw size={14} aria-hidden="true" /> Reopen{:else}<Check
															size={14}
															aria-hidden="true"
														/> Mark done{/if}
												</Button>
												<Button
													size="sm"
													iconOnly
													variant="ghost"
													tone="danger"
													aria-label={`Remove note ${i + 1}`}
													onclick={() => removeNote(n)}
												>
													<Trash2 size={14} aria-hidden="true" />
												</Button>
											</div>
										{/if}
									</li>
								{/each}
							</ol>
						{/if}
					</section>
				</div>
			</TabCard>
		{/if}

		<!-- ONE CARD FOR EACH SCREEN, MODE AND WIDTH, GROUPED BY SCREEN. EACH IS A LINK, SO THE ADDRESS AND THE BACK BUTTON FOLLOW THE CHOICE -->
		{#each groups as g (g.screen)}
			<section class="flex flex-col gap-2" aria-label={g.screen}>
				<h3 class="font-mono text-sm font-semibold text-ink">{g.screen}</h3>
				<ul class="grid [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))] gap-3">
					{#each g.items as s (s.key)}
						{@const cover = s.after ?? s.before}
						{@const open = openCount(s)}
						<li>
							<a
								href={hrefOf(s.key)}
								data-sveltekit-noscroll
								aria-current={selected?.key === s.key ? 'true' : undefined}
								class={cn(
									'flex min-h-14 cursor-pointer flex-col gap-2 rounded-xl border bg-surface p-3 shadow-[var(--elev-1)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
									selected?.key === s.key
										? 'border-accent bg-accent-soft'
										: 'border-line hover:bg-raised'
								)}
							>
								<span
									class="block aspect-[16/10] overflow-hidden rounded-lg border border-line bg-raised"
								>
									{#if cover && !failed[cover.id]}
										<img
											src={cover.image}
											alt=""
											loading="lazy"
											class="size-full object-cover object-top"
											onerror={() => (failed[cover.id] = true)}
										/>
									{/if}
								</span>
								<span class="flex flex-wrap items-center gap-x-2 gap-y-1">
									<Badge>{s.mode === 'dark' ? 'Dark' : 'Light'}</Badge>
									<span class="text-xs text-muted [font-variant-numeric:tabular-nums]"
										>{s.width} px</span
									>
									{#if s.before && s.after}<span class="text-xs text-muted">First and latest</span
										>{/if}
									{#if open > 0}<Badge tone="info">{open} to check</Badge>{/if}
								</span>
								{#if cover?.caption}
									<span class="line-clamp-2 text-xs [overflow-wrap:anywhere] text-muted"
										>{cover.caption}</span
									>
								{/if}
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{/if}
</div>
