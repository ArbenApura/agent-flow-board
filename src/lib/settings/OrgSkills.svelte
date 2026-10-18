<script lang="ts">
	// -- TYPES -- //
	import type { SkillFile } from '#lib/shared/skills.js';
	// -- ENVS -- //
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ago } from '#lib/board/status.js';
	import {
		SKILL_BODY_MAX,
		SKILL_NAME_HINT,
		SKILL_SUMMARY_MAX,
		isBuiltinSkillName,
		isSkillName,
		parseSkillFile
	} from '#lib/shared/skills.js';
	import { askConfirm } from '#lib/ui/confirm.svelte.js';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash from '@lucide/svelte/icons/trash';
	// -- COMPONENTS -- //
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import FilePicker from '#lib/ui/FilePicker.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import StaleWriteDialog from '#lib/ui/StaleWriteDialog.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let {
		skills,
		canManage
	}: {
		skills: {
			id: string;
			name: string;
			summary: string;
			author: string | null;
			revision: number;
			version: number;
			updatedAt: string;
		}[];
		/** Owners and admins write here; everyone else reads. */
		canManage: boolean;
	} = $props();

	// -- CONSTANTS -- //

	const EMPTY = { name: '', summary: '', body: '' };
	const TEXT = 'text-[15px]';

	// -- STATES -- //

	let editorOpen = $state(false);
	let editing = $state<(typeof skills)[number] | null>(null);
	let form = $state({ ...EMPTY });
	let bodyAtOpen = $state('');
	let summaryAtOpen = $state('');
	let baseline = $state<number | null>(null);
	let saving = $state(false);
	let bodyLoading = $state(false);
	let error = $state('');
	let stale = $state<string | null>(null);
	let removing = $state<string | null>(null);
	let intakeOpen = $state(false);
	let intakeError = $state('');

	// -- REACTIVE STATES -- //

	const nameError = $derived(
		form.name && !isSkillName(form.name)
			? isBuiltinSkillName(form.name)
				? `"${form.name}" is one of the board's own workflows. Pick another name.`
				: SKILL_NAME_HINT
			: ''
	);
	const changed = $derived(
		!!form.name.trim() &&
			!!form.summary.trim() &&
			!!form.body.trim() &&
			(editing === null ||
				form.name !== editing.name ||
				form.summary !== editing.summary ||
				form.body !== bodyAtOpen)
	);

	// -- FUNCTIONS -- //

	const org = () => page.params.org ?? '';
	const edited = (s: (typeof skills)[number]) =>
		s.author ? `${s.author}, ${ago(s.updatedAt)}` : ago(s.updatedAt);

	function openNew() {
		editing = null;
		form = { ...EMPTY };
		bodyAtOpen = '';
		summaryAtOpen = '';
		baseline = null;
		error = '';
		intakeOpen = false;
		intakeError = '';
		editorOpen = true;
	}

	async function openEdit(s: (typeof skills)[number]) {
		editing = s;
		form = { name: s.name, summary: s.summary, body: '' };
		bodyAtOpen = '';
		summaryAtOpen = s.summary;
		baseline = s.version;
		error = '';
		intakeOpen = false;
		intakeError = '';
		editorOpen = true;
		bodyLoading = true;
		try {
			const rev = await api<{ body: string; summary: string }>(
				org(),
				`/skills/${s.id}/revisions/${s.revision}`
			);
			form = { name: s.name, summary: rev.summary, body: rev.body };
			bodyAtOpen = rev.body;
			summaryAtOpen = rev.summary;
		} catch (e) {
			error = e instanceof ApiError ? e.message : 'The skill text was not read.';
		} finally {
			bodyLoading = false;
		}
	}

	async function closeEditor() {
		if (saving) return;
		if (changed) {
			const ok = await askConfirm({
				title: 'Discard your changes?',
				body: 'This skill was not saved. Closing it now throws your edits away.',
				confirmLabel: 'Discard',
				tone: 'danger'
			});
			if (!ok) return;
		}
		editorOpen = false;
	}

	function fillFrom(text: string) {
		try {
			const file: SkillFile = parseSkillFile(text);
			form = { name: file.name, summary: file.summary, body: file.body };
			intakeError = '';
			intakeOpen = false;
			toast.success('Read the skill file. Check it, then save.');
		} catch (e) {
			intakeError = e instanceof Error ? e.message : 'That file was not read.';
		}
	}

	async function fromFile(file: File | undefined) {
		if (file) fillFrom(await file.text());
	}

	async function save() {
		if (saving || nameError || !changed) return;
		saving = true;
		error = '';
		try {
			if (editing) {
				// Only what the person changed, so a field somebody else saved meanwhile is kept
				const patch: Record<string, unknown> = { expectVersion: baseline ?? editing.version };
				if (form.name !== editing.name) patch.name = form.name;
				if (form.summary !== summaryAtOpen) patch.summary = form.summary;
				if (form.body !== bodyAtOpen) patch.body = form.body;
				await api(org(), `/skills/${editing.id}`, {
					method: 'PATCH',
					body: patch,
					key: newKey()
				});
			} else
				await api(org(), '/skills', {
					method: 'POST',
					body: form,
					key: newKey()
				});
			toast.success(editing ? 'Saved as a new revision.' : 'Organisation skill added.');
			editorOpen = false;
			await invalidateAll();
		} catch (e) {
			if (e instanceof ApiError && e.code === 'STALE_VERSION')
				stale = String((e.details as { changedAt?: string } | undefined)?.changedAt ?? '');
			else error = e instanceof ApiError ? e.message : 'The skill was not saved.';
		} finally {
			saving = false;
		}
	}

	async function remove(s: (typeof skills)[number]) {
		const ok = await askConfirm({
			title: `Delete ${s.name}?`,
			body: 'Every project stops reading this skill at once. Its history is kept, and a new skill can take the name again.',
			confirmLabel: 'Delete skill',
			tone: 'danger'
		});
		if (!ok) return;
		removing = s.id;
		try {
			await toast.promise(
				api(org(), `/skills/${s.id}?expectVersion=${s.version}`, {
					method: 'DELETE',
					key: newKey()
				}),
				{
					loading: 'Deleting the skill...',
					success: `${s.name} is gone.`,
					error: (e) => (e instanceof ApiError ? e.message : 'The skill was not deleted.')
				}
			);
			await invalidateAll();
		} catch (e) {
			if (e instanceof ApiError && e.code === 'STALE_VERSION') await invalidateAll();
		} finally {
			removing = null;
		}
	}
</script>

<!-- ORGANISATION SKILLS: EVERY PROJECT READS THEM, AND A NAME THEY SHARE WITH A PROJECT SKILL WINS -->
<div class="flex flex-col gap-4">
	<Notice tone="warning" data-testid="org-skill-secrets-notice">
		Every project reads these, so a secret written here is given away to all of them. Never put
		passwords, API keys or tokens in a skill. Every save is kept as a revision.
	</Notice>

	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="text-sm text-muted">
			{skills.length}
			{skills.length === 1 ? 'skill' : 'skills'}, read by every project in this organisation.
		</p>
		{#if canManage}
			<Button onclick={openNew} data-testid="new-org-skill"><Plus size={16} /> New skill</Button>
		{/if}
	</div>

	{#if skills.length === 0}
		<p class="rounded-lg border border-line bg-raised p-4 text-sm text-muted">
			No organisation skills yet. A project skill is read by one project; one added here is read
			everywhere.
		</p>
	{:else}
		<ul class="flex flex-col rounded-lg border border-line" data-testid="org-skill-list">
			{#each skills as s (s.id)}
				<li
					class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-3 last:border-b-0"
					data-testid="org-skill"
				>
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<span class="truncate font-mono text-sm font-medium text-ink">{s.name}</span>
							<Badge tone="info">Organisation</Badge>
							<span class="text-xs text-muted tabular-nums">revision {s.revision}</span>
						</div>
						<p class="mt-0.5 line-clamp-2 text-sm [overflow-wrap:anywhere] text-muted">
							{s.summary}
						</p>
						<p class="mt-0.5 text-xs text-muted">Last saved by {edited(s)}</p>
					</div>
					{#if canManage}
						<div class="flex items-center gap-1">
							<Button
								variant="subtle"
								iconOnly
								aria-label={`Edit ${s.name}`}
								onclick={() => void openEdit(s)}
								data-testid="org-skill-edit"
							>
								<Pencil size={16} />
							</Button>
							<Button
								variant="subtle"
								iconOnly
								aria-label={`Delete ${s.name}`}
								loading={removing === s.id}
								onclick={() => void remove(s)}
								data-testid="org-skill-delete"
							>
								<Trash size={16} />
							</Button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

<ResponsiveModal
	open={editorOpen}
	onclose={() => void closeEditor()}
	title={editing ? `Edit ${editing.name}` : 'New organisation skill'}
	size="lg"
	busy={saving}
>
	<form
		id="org-skill-form"
		class={cn('flex flex-col gap-4', TEXT)}
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		{#if intakeOpen}
			<div class="flex flex-col gap-3 rounded-lg border border-line bg-raised p-3">
				<FilePicker
					label="Upload a SKILL.md"
					hint="Its name and description fill the fields below."
					accept=".md,text/markdown"
					disabled={saving}
					onchange={(file) => void fromFile(file)}
				/>
				{#if intakeError}
					<p role="alert" class={cn(TEXT, 'text-danger')}>{intakeError}</p>
				{/if}
				<div class="flex justify-end">
					<Button onclick={() => (intakeOpen = false)} disabled={saving}>Close</Button>
				</div>
			</div>
		{:else}
			<div>
				<Button onclick={() => (intakeOpen = true)} disabled={saving}>Start from a SKILL.md</Button>
			</div>
		{/if}
		<TextField
			label="What is the skill called"
			bind:value={form.name}
			required
			maxlength={64}
			disabled={saving}
			error={nameError}
			hint={nameError ? undefined : SKILL_NAME_HINT}
			class={TEXT}
			data-testid="org-skill-name"
		/>
		<TextField
			label="How would you describe it in one line"
			bind:value={form.summary}
			required
			maxlength={SKILL_SUMMARY_MAX}
			disabled={saving}
			hint={`${form.summary.length} of ${SKILL_SUMMARY_MAX} characters.`}
			class={TEXT}
			data-testid="org-skill-summary"
		/>
		<TextArea
			label="What should an agent do when it reads this skill"
			bind:value={form.body}
			required
			rows={14}
			maxlength={SKILL_BODY_MAX}
			disabled={saving || bodyLoading}
			class={cn('font-mono', TEXT)}
			hint={bodyLoading
				? 'Reading the current text...'
				: `${form.body.length} of ${SKILL_BODY_MAX} characters. Markdown is kept as you write it.`}
			data-testid="org-skill-body"
		/>
		{#if error}
			<p role="alert" class={cn(TEXT, 'text-danger')}>{error}</p>
		{/if}
	</form>
	{#snippet footer()}
		<Button onclick={() => void closeEditor()} disabled={saving}>Cancel</Button>
		<Button
			type="submit"
			form="org-skill-form"
			variant="primary"
			loading={saving}
			disabled={!changed || !!nameError || bodyLoading}
			data-testid="org-skill-save">{editing ? 'Save changes' : 'Add skill'}</Button
		>
	{/snippet}
</ResponsiveModal>

<StaleWriteDialog
	open={stale !== null}
	onclose={() => (stale = null)}
	changedBy="Someone"
	changedAt={stale ? new Date(stale).toLocaleString('en') : ''}
	onreload={async () => {
		stale = null;
		editorOpen = false;
		await invalidateAll();
	}}
	oncompare={async () => {
		stale = null;
		const fresh = skills.find((s) => s.id === editing?.id);
		await invalidateAll();
		if (fresh) {
			editing = fresh;
			baseline = fresh.version;
		}
	}}
/>
