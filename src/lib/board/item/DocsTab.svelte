<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	// IMPORTED DEP-MODULES
	import { tick } from 'svelte';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import StaleWriteDialog from '#lib/ui/StaleWriteDialog.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// IMPORTED DEP-COMPONENTS
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';

	// -- REQUIRED PROPS -- //

	let { detail, env }: { detail: ItemView; env: TabEnv } = $props();

	// -- CONSTANTS -- //

	// The line the sticky blocks stop at, in pixels from the top of the window: the tab bar ends at 123 and keeps 8 below it
	const STICKY = 131;
	// From 1536 px the tab bar is in the top bar and the card under it is gone, so the line is where the top bar ends (65) plus the same 8 (the 2xl: classes below say the same)
	const STICKY_WIDE = 73;
	const WIDE = '(min-width: 1536px)';
	// A heading jumped to rests 8 px under that line (its scroll margin is the same 139 px), so it is the current one from there
	const HEADING_GAP = 8;

	// -- STATES -- //

	let editing = $state<{ slug: string; title: string; version: number; isNew: boolean } | null>(
		null
	);
	let slug = $state('');
	let title = $state('');
	let body = $state('');
	let busy = $state(false);
	let error = $state('');
	let stale = $state<{ changedAt: string } | null>(null);
	let chipRow = $state<HTMLElement>();
	/** The section card each section keeps open or closed, by section id, so a jump can open one. */
	let collapsedBy = $state<Record<string, boolean>>({});
	/** The section last jumped to, so its chip can slide to the middle of the row. */
	let activeId = $state('');
	/** The headings (h2 and h3) of every open section, read from the rendered cards, by section id. */
	let sectionHeadings = $state<Record<string, { text: string; level: number }[]>>({});
	/** The open section whose card crosses the sticky line, and the last of its headings above that line. */
	let currentSection = $state('');
	let activeIndex = $state(-1);
	/** The heading elements behind sectionHeadings, for the scroll position and the jump. Not reactive. */
	let headingEls: Record<string, HTMLElement[]> = {};
	let frame = 0;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;

	// -- REACTIVE STATES -- //

	const outlineItems = $derived(sectionHeadings[currentSection] ?? []);

	// -- REACTIVE STATEMENTS -- //

	// The outline follows the text and what is open: after a reload of the sections or a stored collapse restored by a card, the headings are read again from the rendered cards
	$effect(() => {
		void detail.sections.map((s) => s.html);
		void detail.sections.map((s) => collapsedBy[s.id]);
		void tick().then(collect);
	});

	$effect(() => () => {
		cancelAnimationFrame(frame);
		clearTimeout(settleTimer);
	});

	// On a phone the chip of the section just jumped to slides to the middle of its row, with the row's own scroll so the page never moves
	$effect(() => {
		void activeId;
		const row = chipRow;
		const current = row?.querySelector<HTMLElement>('[aria-current="location"]');
		if (!row || !current || row.scrollWidth <= row.clientWidth) return;
		const left =
			current.getBoundingClientRect().left -
			row.getBoundingClientRect().left +
			row.scrollLeft -
			(row.clientWidth - current.offsetWidth) / 2;
		row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
	});

	// -- FUNCTIONS -- //

	const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

	/** Reads the h2 and h3 headings of every open card, then places the sticky line among them. */
	function collect() {
		headingEls = {};
		const found: Record<string, { text: string; level: number }[]> = {};
		for (const s of detail.sections) {
			if (collapsedBy[s.id]) continue;
			const els = [
				...(document
					.getElementById(`doc-${s.id}`)
					?.querySelectorAll<HTMLElement>('.md :is(h2, h3)') ?? [])
			].filter((el) => (el.textContent ?? '').trim() !== '');
			if (els.length === 0) continue;
			headingEls[s.id] = els;
			found[s.id] = els.map((el) => ({
				text: (el.textContent ?? '').trim(),
				level: el.tagName === 'H3' ? 3 : 2
			}));
		}
		sectionHeadings = found;
		measure();
		// A card opens and closes over 200 ms, so the positions settle after this read: measure again then
		clearTimeout(settleTimer);
		settleTimer = setTimeout(schedule, 220);
	}

	/** The last open card that starts above the sticky line is the current section, and the last heading above the line is the current heading. */
	function measure() {
		const line = matchMedia(WIDE).matches ? STICKY_WIDE : STICKY;
		let section = '';
		for (const s of detail.sections) {
			if (collapsedBy[s.id]) continue;
			const el = document.getElementById(`doc-${s.id}`);
			if (!el) continue;
			if (!section || el.getBoundingClientRect().top <= line + 1) section = s.id;
		}
		currentSection = section;
		const els = headingEls[section] ?? [];
		let index = -1;
		els.forEach((h, i) => {
			if (h.getBoundingClientRect().top <= line + HEADING_GAP + 1) index = i;
		});
		// At the very bottom of a short page the last headings can never reach the line, so the last one counts
		const bottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
		if (bottom && els.length > 0 && index >= 0) index = els.length - 1;
		activeIndex = index;
	}

	/** One measure for each frame while the page scrolls or resizes. */
	function schedule() {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			measure();
		});
	}

	function jumpHeading(index: number) {
		headingEls[currentSection]?.[index]?.scrollIntoView({
			block: 'start',
			behavior: reduced() ? 'auto' : 'smooth'
		});
	}

	/** Opens or closes every section card. Like a jump, this is not stored as the person's own choice. */
	function setAll(open: boolean) {
		for (const s of detail.sections) collapsedBy[s.id] = !open;
	}

	/** Opens the section if it is closed, then scrolls to it. */
	async function jump(id: string) {
		activeId = id;
		collapsedBy[id] = false;
		await tick();
		document.getElementById(`doc-${id}`)?.scrollIntoView({
			block: 'start',
			behavior: reduced() ? 'auto' : 'smooth'
		});
	}

	const slugify = (v: string) =>
		v
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40);

	function edit(s: ItemView['sections'][number] | null) {
		error = '';
		if (s) {
			editing = { slug: s.slug, title: s.title, version: s.version, isNew: false };
			slug = s.slug;
			title = s.title;
			body = s.body;
		} else {
			editing = { slug: '', title: '', version: 0, isNew: true };
			slug = title = body = '';
		}
	}

	async function save() {
		if (!editing) return;
		const target = editing.isNew ? slugify(slug || title) : editing.slug;
		error = '';
		busy = true;
		try {
			await toast.promise(
				api(env.org, `/items/${detail.item.ref}/sections/${target}`, {
					method: 'PUT',
					body: {
						title: title.trim(),
						body,
						...(editing.isNew ? {} : { expectVersion: editing.version })
					},
					key: newKey()
				}),
				{
					loading: 'Saving the section...',
					success: 'Saved.',
					error: (e) =>
						e instanceof ApiError && e.code === 'STALE_VERSION'
							? 'Someone changed this section first.'
							: e instanceof ApiError
								? e.message
								: 'That was not saved.'
				}
			);
			editing = null;
			await env.onchanged();
		} catch (e) {
			if (e instanceof ApiError && e.code === 'STALE_VERSION') {
				stale = {
					changedAt: String((e.details as { changedAt?: string } | undefined)?.changedAt ?? '')
				};
			} else error = e instanceof ApiError ? e.message : 'That was not saved.';
		} finally {
			busy = false;
		}
	}

	/** Throws away the edit and shows the newer version. */
	async function reload() {
		stale = null;
		editing = null;
		await env.onchanged();
	}
</script>

<!-- THE OUTLINE AND THE CURRENT SECTION FOLLOW THE SCROLL POSITION -->
<svelte:window onscroll={schedule} onresize={schedule} />

<div class="flex flex-col gap-6" data-testid="docs-tab">
	<!-- ADD A SECTION NEEDS WRITE ACCESS, OPENING AND CLOSING THE CARDS IS FOR EVERYONE WHEN THERE ARE TWO OR MORE -->
	{#if env.canWrite || detail.sections.length > 1}
		<div class="flex flex-wrap items-center gap-2">
			{#if env.canWrite}
				<Button size="sm" onclick={() => edit(null)} data-testid="add-section"
					><Plus size={14} /> Add a section</Button
				>
			{/if}
			{#if detail.sections.length > 1}
				<Button
					size="sm"
					variant="ghost"
					class="max-sm:w-11 max-sm:px-0"
					aria-label="Expand all"
					onclick={() => setAll(true)}
					data-testid="expand-all"
					><ChevronsUpDown size={14} aria-hidden="true" /><span class="max-sm:sr-only"
						>Expand all</span
					></Button
				>
				<Button
					size="sm"
					variant="ghost"
					class="max-sm:w-11 max-sm:px-0"
					aria-label="Collapse all"
					onclick={() => setAll(false)}
					data-testid="collapse-all"
					><ChevronsDownUp size={14} aria-hidden="true" /><span class="max-sm:sr-only"
						>Collapse all</span
					></Button
				>
			{/if}
		</div>
	{/if}
	{#if detail.sections.length === 0}
		<EmptyState
			kind="docs"
			title="No documents yet"
			text="Sections hold the spec, the plan notes and the validation steps of this item, written in Markdown."
		/>
	{/if}
	<!-- A CONTENTS LIST AT THE SIDE ON A WIDE SCREEN, A ROW OF CHIPS ABOVE THE SECTIONS ON A SMALLER ONE. IT NEEDS TWO SECTIONS OR MORE -->
	{#if detail.sections.length > 1}
		<nav aria-label="Sections of this document" class="lg:hidden">
			<div
				bind:this={chipRow}
				class="[scrollbar-width:none]! overflow-x-auto overflow-y-hidden overscroll-x-contain [&::-webkit-scrollbar]:hidden"
			>
				<ul class="flex w-max gap-2">
					{#each detail.sections as s (s.id)}
						<li>
							<a
								href={`#doc-${s.id}`}
								aria-current={activeId === s.id ? 'location' : undefined}
								onclick={(e) => {
									e.preventDefault();
									void jump(s.id);
								}}
								class={cn(
									'flex min-h-11 cursor-pointer items-center rounded-full border px-4 text-sm whitespace-nowrap',
									activeId === s.id
										? 'border-ink bg-raised font-medium text-ink'
										: 'border-line text-muted hover:text-ink'
								)}>{s.title}</a
							>
						</li>
					{/each}
				</ul>
			</div>
		</nav>
	{/if}

	<div
		class={cn(
			detail.sections.length > 1 &&
				'lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:items-start lg:gap-6 xl:grid-cols-[200px_minmax(0,1fr)_240px]'
		)}
	>
		{#if detail.sections.length > 1}
			<nav
				aria-label="Contents"
				class="sticky top-[131px] hidden max-h-[calc(100dvh-147px)] overflow-y-auto rounded-xl border border-line bg-surface p-2 shadow-[var(--elev-1)] lg:block 2xl:top-[73px] 2xl:max-h-[calc(100dvh-89px)]"
			>
				<ul class="flex flex-col gap-0.5">
					{#each detail.sections as s (s.id)}
						<li>
							<a
								href={`#doc-${s.id}`}
								aria-current={activeId === s.id ? 'location' : undefined}
								onclick={(e) => {
									e.preventDefault();
									void jump(s.id);
								}}
								class={cn(
									'block min-h-10 cursor-pointer rounded-md px-3 py-2 text-sm break-words hover:bg-raised hover:text-ink',
									activeId === s.id ? 'bg-raised font-medium text-ink' : 'text-muted'
								)}>{s.title}</a
							>
						</li>
					{/each}
				</ul>
			</nav>
		{/if}
		<div class="flex min-w-0 flex-col gap-4">
			{#each detail.sections as s (s.id)}
				<TabCard
					id={`doc-${s.id}`}
					collapsible
					storageKey={`afb:collapse:${env.org}:${detail.item.id}:doc-${s.id}`}
					bind:collapsed={() => collapsedBy[s.id] ?? false, (v) => (collapsedBy[s.id] = v)}
					role="region"
					aria-label={s.title}
					class="scroll-mt-[131px] 2xl:scroll-mt-[73px]"
				>
					{#snippet heading()}{s.title}{/snippet}
					{#snippet actions()}
						{#if env.canWrite}
							<Button variant="ghost" size="sm" onclick={() => edit(s)}
								><Pencil size={14} aria-hidden="true" /> Edit</Button
							>
						{/if}
					{/snippet}
					<div
						class="md p-4 max-sm:p-3.5 [&_:is(h2,h3)]:scroll-mt-[139px] 2xl:[&_:is(h2,h3)]:scroll-mt-[81px]"
					>
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown from the server -->
						{@html s.html}
					</div>
				</TabCard>
			{/each}
		</div>
		<!-- ON THIS PAGE: THE HEADINGS OF THE SECTION UNDER THE STICKY LINE, FROM XL UP. THE ENTRIES ARE READ FROM THE RENDERED CARD, SO THEY ARE BUTTONS AND NOT ANCHORS -->
		{#if detail.sections.length > 1 && outlineItems.length > 0}
			<nav
				aria-label="On this page"
				class="sticky top-[131px] hidden self-start xl:block 2xl:top-[73px]"
			>
				<p class="mb-2 pl-3 text-sm font-semibold">On this page</p>
				<ul class="border-l border-line">
					{#each outlineItems as h, i (`${i}:${h.text}`)}
						<li>
							<button
								type="button"
								aria-current={activeIndex === i ? 'location' : undefined}
								onclick={() => jumpHeading(i)}
								class={cn(
									'-ml-px block min-h-8 w-full cursor-pointer border-l-2 py-1.5 pr-2 text-left text-sm break-words hover:text-ink',
									h.level === 3 ? 'pl-6' : 'pl-3',
									activeIndex === i
										? 'border-accent font-medium text-ink'
										: 'border-transparent text-muted'
								)}
							>
								{h.text}
							</button>
						</li>
					{/each}
				</ul>
			</nav>
		{/if}
	</div>
</div>

<ResponsiveModal
	open={editing !== null}
	onclose={() => (editing = null)}
	title={editing?.isNew ? 'Add a section' : 'Edit the section'}
	size="lg"
	{busy}
>
	<form
		class="flex flex-col gap-3"
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		<TextField label="Section title" bind:value={title} required />
		<TextArea
			label="Text, in Markdown"
			bind:value={body}
			rows={12}
			{error}
			data-testid="section-body"
		/>
		<div class="flex justify-end gap-2">
			<Button onclick={() => (editing = null)} disabled={busy}>Cancel</Button>
			<Button type="submit" variant="primary" loading={busy} data-testid="section-save">Save</Button
			>
		</div>
	</form>
</ResponsiveModal>

<StaleWriteDialog
	open={stale !== null}
	onclose={() => (stale = null)}
	changedBy="Someone"
	changedAt={stale?.changedAt ? new Date(stale.changedAt).toLocaleString('en') : 'just now'}
	onreload={reload}
	oncompare={() => (stale = null)}
/>
