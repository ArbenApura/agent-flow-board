<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- DEP-MODULES -- //
	import { tick } from 'svelte';
	// -- MODULES -- //
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
	// -- DEP-COMPONENTS -- //
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';

	// -- REQUIRED PROPS -- //

	let { detail, env }: { detail: ItemView; env: TabEnv } = $props();

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

	// -- REACTIVE STATEMENTS -- //

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

	/** Opens the section if it is closed, then scrolls to it. */
	async function jump(id: string) {
		activeId = id;
		collapsedBy[id] = false;
		await tick();
		document.getElementById(`doc-${id}`)?.scrollIntoView({
			block: 'start',
			behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
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

<div class="flex flex-col gap-4" data-testid="docs-tab">
	{#if env.canWrite}
		<div>
			<Button size="sm" onclick={() => edit(null)} data-testid="add-section"
				><Plus size={14} /> Add a section</Button
			>
		</div>
	{/if}
	{#if detail.sections.length === 0}
		<EmptyState
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
				'lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:items-start lg:gap-8'
		)}
	>
		{#if detail.sections.length > 1}
			<nav
				aria-label="Contents"
				class="sticky top-32 hidden max-h-[calc(100dvh-9rem)] overflow-y-auto rounded-xl border border-line bg-surface p-2 shadow-[var(--elev-1)] lg:block"
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
					class="scroll-mt-32"
				>
					{#snippet heading()}{s.title}{/snippet}
					{#snippet actions()}
						{#if env.canWrite}
							<Button variant="ghost" size="sm" onclick={() => edit(s)}
								><Pencil size={14} aria-hidden="true" /> Edit</Button
							>
						{/if}
					{/snippet}
					<div class="md p-4 max-sm:p-3.5">
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown from the server -->
						{@html s.html}
					</div>
				</TabCard>
			{/each}
		</div>
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
