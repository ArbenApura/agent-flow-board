<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	// -- TYPES -- //
	import type { SkillFile } from '#lib/shared/skills.js';
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
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
	import Clock from '@lucide/svelte/icons/clock';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash from '@lucide/svelte/icons/trash';
	// -- COMPONENTS -- //
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import FilePicker from '#lib/ui/FilePicker.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import PermissionDenied from '#lib/ui/PermissionDenied.svelte';
	import ResponsiveModal from '#lib/ui/ResponsiveModal.svelte';
	import StaleWriteDialog from '#lib/ui/StaleWriteDialog.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- TYPES -- //

	type SkillRow = PageProps['data']['skills'][number];
	type RevisionRow = {
		revision: number;
		hash: string;
		summary: string;
		author: string | null;
		createdAt: string;
	};

	// -- CONSTANTS -- //

	const EMPTY = { name: '', summary: '', body: '' };
	/** The editor is a form, so every field and its button carry one size. */
	const TEXT = 'text-[15px]';

	// -- STATES -- //

	let editorOpen = $state(false);
	/** The skill being edited, or null when the editor is making a new one. */
	let editing = $state<SkillRow | null>(null);
	let form = $state({ ...EMPTY });
	/** The version the editor started from, so a save from an old page is refused rather than overwriting. */
	let baseline = $state<number | null>(null);
	let bodyLoading = $state(false);
	let saving = $state(false);
	let error = $state('');
	let stale = $state<string | null>(null);
	/** The skill whose history is open, kept while the drawer closes so it does not go blank. */
	let historyOf = $state<SkillRow | null>(null);
	let historyOpen = $state(false);
	let revisions = $state<RevisionRow[]>([]);
	let viewing = $state<{ revision: number; body: string; summary: string } | null>(null);
	let historyBusy = $state(false);
	let historyError = $state('');
	let removing = $state<string | null>(null);
	/** The summary and body the editor opened with, so a save sends only what the person changed. */
	let bodyAtOpen = $state('');
	let summaryAtOpen = $state('');
	/** The SKILL.md intake: a file or pasted text that fills the form. */
	let intakeOpen = $state(false);
	let pasted = $state('');
	let intakeError = $state('');

	// -- REACTIVE STATES -- //

	const canWrite = $derived(data.access?.canWrite ?? false);
	const canManage = $derived(data.access?.canManage ?? false);
	const projectSkills = $derived(data.skills.filter((s) => s.source === 'project'));
	const orgSkills = $derived(data.skills.filter((s) => s.source === 'org'));
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

	const sourceLabel = (s: SkillRow) => (s.source === 'org' ? 'Organisation' : 'Project');
	const edited = (s: SkillRow) =>
		s.author ? `${s.author}, ${ago(s.updatedAt)}` : ago(s.updatedAt);
	const canEdit = (s: SkillRow) => (s.source === 'org' ? canManage : canWrite);

	function openNew() {
		editing = null;
		form = { ...EMPTY };
		bodyAtOpen = '';
		summaryAtOpen = '';
		baseline = null;
		error = '';
		intakeOpen = false;
		pasted = '';
		intakeError = '';
		editorOpen = true;
	}

	async function openEdit(s: SkillRow) {
		editing = s;
		form = { name: s.name, summary: s.summary, body: '' };
		bodyAtOpen = '';
		summaryAtOpen = s.summary;
		baseline = s.version;
		error = '';
		intakeOpen = false;
		pasted = '';
		intakeError = '';
		editorOpen = true;
		bodyLoading = true;
		try {
			// The id names exactly one row, so an organisation skill of the same name is never read in its place
			const rev = await api<{ body: string; summary: string }>(
				page.params.org ?? '',
				`/projects/${page.params.project}/skills/${s.id}/revisions/${s.revision}`
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

	/** Reads a SKILL.md into the form, from a file or from text the person pasted. */
	function fillFrom(text: string) {
		try {
			const file: SkillFile = parseSkillFile(text);
			form = { name: file.name, summary: file.summary, body: file.body };
			intakeError = '';
			intakeOpen = false;
			pasted = '';
			toast.success('Read the skill file. Check it, then save.');
		} catch (e) {
			intakeError = e instanceof Error ? e.message : 'That file was not read.';
		}
	}

	async function fromFile(file: File | undefined) {
		if (!file) return;
		fillFrom(await file.text());
	}

	async function save() {
		if (saving || nameError || !form.name.trim() || !form.summary.trim() || !form.body.trim())
			return;
		saving = true;
		error = '';
		const org = page.params.org ?? '';
		const key = page.params.project ?? '';
		try {
			if (editing) {
				// Only the fields the person changed are sent, so a field somebody else saved meanwhile is kept
				const patch: Record<string, unknown> = { expectVersion: baseline ?? editing.version };
				if (form.name !== editing.name) patch.name = form.name;
				if (form.summary !== summaryAtOpen) patch.summary = form.summary;
				if (form.body !== bodyAtOpen) patch.body = form.body;
				await api(org, `/skills/${editing.id}`, {
					method: 'PATCH',
					body: patch,
					key: newKey()
				});
			} else {
				await api(org, `/projects/${key}/skills`, {
					method: 'POST',
					body: form,
					key: newKey()
				});
			}
			toast.success(editing ? 'Skill saved as a new revision.' : 'Skill added.');
			editorOpen = false;
			await invalidate('afb:project');
		} catch (e) {
			if (e instanceof ApiError && e.code === 'STALE_VERSION')
				stale = String((e.details as { changedAt?: string } | undefined)?.changedAt ?? '');
			else error = e instanceof ApiError ? e.message : 'The skill was not saved.';
		} finally {
			saving = false;
		}
	}

	async function remove(s: SkillRow) {
		const ok = await askConfirm({
			title: `Delete ${s.name}?`,
			body:
				s.source === 'org'
					? 'Every project in this organisation stops reading this skill at once. Its history is kept, and a new skill can take the name again.'
					: 'Agents in this project stop reading this skill at once. Its history is kept, and a new skill can take the name again.',
			confirmLabel: 'Delete skill',
			tone: 'danger'
		});
		if (!ok) return;
		removing = s.id;
		try {
			await toast.promise(
				api(page.params.org ?? '', `/skills/${s.id}?expectVersion=${s.version}`, {
					method: 'DELETE',
					key: newKey()
				}),
				{
					loading: 'Deleting the skill...',
					success: `${s.name} is gone.`,
					error: (e) => (e instanceof ApiError ? e.message : 'The skill was not deleted.')
				}
			);
			await invalidate('afb:project');
		} catch (e) {
			if (e instanceof ApiError && e.code === 'STALE_VERSION') await invalidate('afb:project');
		} finally {
			removing = null;
		}
	}

	async function openHistory(s: SkillRow) {
		historyOf = s;
		historyOpen = true;
		viewing = null;
		historyError = '';
		historyBusy = true;
		revisions = [];
		try {
			revisions = await api<RevisionRow[]>(
				page.params.org ?? '',
				`/projects/${page.params.project}/skills/${s.id}/revisions`
			);
		} catch (e) {
			historyError = e instanceof ApiError ? e.message : 'The history was not read.';
		} finally {
			historyBusy = false;
		}
	}

	async function viewRevision(revision: number) {
		if (!historyOf) return;
		historyBusy = true;
		historyError = '';
		try {
			viewing = await api<{ revision: number; body: string; summary: string }>(
				page.params.org ?? '',
				`/projects/${page.params.project}/skills/${historyOf.id}/revisions/${revision}`
			);
		} catch (e) {
			historyError = e instanceof ApiError ? e.message : 'That revision was not read.';
		} finally {
			historyBusy = false;
		}
	}
</script>

<svelte:head><title>Skills, {data.access?.projectKey ?? ''}</title></svelte:head>

{#snippet row(s: SkillRow)}
	<li
		class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-b-0"
		data-testid="skill"
	>
		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-2">
				<span class="truncate font-mono text-sm font-medium text-ink">{s.name}</span>
				<Badge tone={s.source === 'org' ? 'info' : 'neutral'}>{sourceLabel(s)}</Badge>
				<span class="text-xs text-muted tabular-nums">revision {s.revision}</span>
			</div>
			<p class="mt-0.5 line-clamp-2 text-sm [overflow-wrap:anywhere] text-muted">{s.summary}</p>
			<p class="mt-0.5 text-xs text-muted">Last saved by {edited(s)}</p>
		</div>
		<div class="flex items-center gap-1">
			<Button
				variant="subtle"
				iconOnly
				aria-label={`History of ${s.name}`}
				onclick={() => void openHistory(s)}
			>
				<Clock size={16} />
			</Button>
			{#if canEdit(s)}
				<Button
					variant="subtle"
					iconOnly
					aria-label={`Edit ${s.name}`}
					onclick={() => void openEdit(s)}
					data-testid="skill-edit"
				>
					<Pencil size={16} />
				</Button>
				<Button
					variant="subtle"
					iconOnly
					aria-label={`Delete ${s.name}`}
					loading={removing === s.id}
					onclick={() => void remove(s)}
					data-testid="skill-delete"
				>
					<Trash size={16} />
				</Button>
			{/if}
		</div>
	</li>
{/snippet}

<PageFrame class="flex flex-col gap-4 pb-12">
	{#if data.access?.guest}
		<PermissionDenied needed="Member" current="Guest" what="this project's skills" />
	{:else}
		<PageHeader
			class="mb-2!"
			title="Skills"
			context={`${data.skills.length} ${data.skills.length === 1 ? 'skill' : 'skills'}, instructions every agent connected to this project reads.`}
		>
			{#snippet actions()}
				{#if canWrite}
					<Button variant="primary" onclick={openNew} data-testid="new-skill">
						<Plus size={16} /> New skill
					</Button>
				{/if}
			{/snippet}
		</PageHeader>

		<Notice tone="warning" data-testid="skill-secrets-notice">
			A skill is an instruction every agent in this project follows, so a secret written here is
			given away. Never put passwords, API keys or tokens in one. Every save is kept as a revision.
		</Notice>

		{#if data.skills.length === 0}
			<EmptyState
				kind="tools"
				title="No skills yet"
				text="A skill is your team's own instructions, read over MCP by every agent that works in this project. Add the first one."
			>
				{#snippet action()}
					{#if canWrite}
						<Button onclick={openNew}>New skill</Button>
					{/if}
				{/snippet}
			</EmptyState>
		{:else}
			<!-- PROJECT SKILLS AND THE ORGANISATION ONES. AN AGENT READS THE ORGANISATION ONE WHEN BOTH SHARE A NAME -->
			<section class="flex flex-col gap-2">
				<h2 class="text-lg font-semibold text-ink">This project</h2>
				{#if projectSkills.length}
					<ul
						class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
						data-testid="project-skills"
					>
						{#each projectSkills as s (s.id)}
							{@render row(s)}
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted">No skill of this project's own yet.</p>
				{/if}
			</section>
			<section class="flex flex-col gap-2">
				<h2 class="text-lg font-semibold text-ink">From the organisation</h2>
				{#if orgSkills.length}
					<p class="text-sm text-muted">
						Every project reads these. When a name exists in both places, an agent reads this one.
					</p>
					<ul
						class="rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
						data-testid="org-skills"
					>
						{#each orgSkills as s (s.id)}
							{@render row(s)}
						{/each}
					</ul>
				{:else}
					<p class="text-sm text-muted">The organisation has no skills yet.</p>
				{/if}
			</section>
			<p class="text-sm text-muted">
				An agent reads a skill with <span class="font-mono text-xs">skill_get</span>, and sees it as
				a prompt named
				<span class="font-mono text-xs">{data.access?.projectKey.toLowerCase()}-&lt;name&gt;</span>.
				A file at <span class="font-mono text-xs">.claude/skills/&lt;name&gt;/SKILL.md</span> in the checkout
				wins over both.
			</p>
		{/if}
	{/if}
</PageFrame>

<!-- THE EDITOR. MOUNTED ALWAYS, WITH ITS DATA KEPT THROUGH THE CLOSE TRANSITION -->
<ResponsiveModal
	open={editorOpen}
	onclose={() => void closeEditor()}
	title={editing ? `Edit ${editing.name}` : 'New skill'}
	size="lg"
	busy={saving}
>
	<form
		id="skill-form"
		class={cn('flex flex-col gap-4', TEXT)}
		onsubmit={(e) => {
			e.preventDefault();
			void save();
		}}
	>
		{#if intakeOpen}
			<!-- ONE SKILL.md FILLS THE FORM. THE FILE AND A PASTE GO THROUGH THE SAME FLAT PARSER AS THE IMPORT VERB -->
			<div class="flex flex-col gap-3 rounded-lg border border-line bg-raised p-3">
				<FilePicker
					label="Upload a SKILL.md"
					hint="Its name and description fill the fields below."
					accept=".md,text/markdown"
					disabled={saving}
					onchange={(file) => void fromFile(file)}
				/>
				<TextArea
					label="or paste the text of a SKILL.md"
					bind:value={pasted}
					rows={6}
					class="font-mono text-xs"
					placeholder="---&#10;name: release-notes&#10;description: How we write the release notes&#10;---"
				/>
				<div class="flex justify-end gap-2">
					<Button onclick={() => (intakeOpen = false)} disabled={saving}>Close</Button>
					<Button
						onclick={() => fillFrom(pasted)}
						disabled={saving || !pasted.trim()}
						data-testid="skill-intake-fill">Read it into the form</Button
					>
				</div>
				{#if intakeError}
					<p role="alert" class={cn(TEXT, 'text-danger')}>{intakeError}</p>
				{/if}
			</div>
		{:else}
			<div>
				<Button
					onclick={() => (intakeOpen = true)}
					disabled={saving}
					data-testid="skill-intake-open"
				>
					Start from a SKILL.md
				</Button>
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
			data-testid="skill-name"
		/>
		<TextField
			label="How would you describe it in one line"
			bind:value={form.summary}
			required
			maxlength={SKILL_SUMMARY_MAX}
			disabled={saving}
			hint={`${form.summary.length} of ${SKILL_SUMMARY_MAX} characters. This is what project_rules lists.`}
			class={TEXT}
			data-testid="skill-summary"
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
			data-testid="skill-body"
		/>
		{#if error}
			<p role="alert" class={cn(TEXT, 'text-danger')}>{error}</p>
		{/if}
	</form>
	{#snippet footer()}
		<Button onclick={() => void closeEditor()} disabled={saving}>Cancel</Button>
		<Button
			type="submit"
			form="skill-form"
			variant="primary"
			loading={saving}
			disabled={!changed || !!nameError || bodyLoading}
			data-testid="skill-save"
		>
			{editing ? 'Save changes' : 'Add skill'}
		</Button>
	{/snippet}
</ResponsiveModal>

<!-- THE HISTORY: ONE ROW PER REVISION, AND THE TEXT OF THE ONE THAT IS OPEN -->
<ResponsiveModal
	open={historyOpen}
	onclose={() => (historyOpen = false)}
	title={historyOf ? `${historyOf.name}, history` : 'History'}
	variant="drawer"
	size="lg"
	busy={historyBusy}
>
	{#if historyError}
		<Notice tone="danger">{historyError}</Notice>
	{:else if historyBusy && !revisions.length}
		<p class="text-sm text-muted">Reading the history...</p>
	{:else}
		<ul class="flex flex-col gap-1">
			{#each revisions as r (r.revision)}
				<li>
					<button
						type="button"
						onclick={() => void viewRevision(r.revision)}
						aria-current={viewing?.revision === r.revision ? 'true' : undefined}
						class={cn(
							'flex min-h-11 w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-raised',
							viewing?.revision === r.revision && 'bg-raised'
						)}
					>
						<span class="text-sm text-ink">
							Revision {r.revision}
							{#if historyOf && r.revision === historyOf.revision}
								<span class="text-xs text-muted">(the one agents read now)</span>
							{/if}
						</span>
						<span class="text-xs text-muted">
							{r.author ?? 'Someone'}, {ago(r.createdAt)}
						</span>
					</button>
				</li>
			{/each}
		</ul>
		{#if viewing}
			<div class="mt-4 flex flex-col gap-2 border-t border-line pt-4">
				<p class="text-sm text-muted">{viewing.summary}</p>
				<pre
					class="max-h-[50vh] overflow-auto rounded-lg border border-line bg-raised p-3 font-mono text-xs whitespace-pre-wrap text-ink">{viewing.body}</pre>
			</div>
		{/if}
	{/if}
</ResponsiveModal>

<StaleWriteDialog
	open={stale !== null}
	onclose={() => (stale = null)}
	changedBy="Someone"
	changedAt={stale ? new Date(stale).toLocaleString('en') : ''}
	onreload={async () => {
		stale = null;
		editorOpen = false;
		await invalidate('afb:project');
	}}
	oncompare={async () => {
		// The draft stays and is rebased onto the newer version. The next save sends only the fields changed here, so the
		// summary or body the other person saved is kept rather than written back to the old text
		stale = null;
		await invalidate('afb:project');
		const fresh = data.skills.find((s) => s.id === editing?.id);
		if (fresh) {
			editing = fresh;
			baseline = fresh.version;
		}
	}}
/>
