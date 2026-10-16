<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ItemView, TabEnv } from '#lib/board/item/types.js';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
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

	// -- FUNCTIONS -- //

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
			await api(env.org, `/items/${detail.item.ref}/sections/${target}`, {
				method: 'PUT',
				body: {
					title: title.trim(),
					body,
					...(editing.isNew ? {} : { expectVersion: editing.version })
				},
				key: newKey()
			});
			editing = null;
			toast.success('Saved.');
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
	{#each detail.sections as s (s.id)}
		<section
			class="rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)]"
			aria-label={s.title}
		>
			<div class="mb-2 flex items-center justify-between gap-2">
				<h2 class="text-lg font-semibold">{s.title}</h2>
				{#if env.canWrite}
					<Button variant="ghost" size="sm" onclick={() => edit(s)}
						><Pencil size={14} /> Edit</Button
					>
				{/if}
			</div>
			<div class="md">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitised Markdown from the server -->
				{@html s.html}
			</div>
		</section>
	{/each}
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
