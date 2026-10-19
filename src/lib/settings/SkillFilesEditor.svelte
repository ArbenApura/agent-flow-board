<script lang="ts">
	// -- TYPES -- //
	import type { DraftFile } from '#lib/settings/skillFiles.js';
	// -- MODULES -- //
	import { newDraft } from '#lib/settings/skillFiles.js';
	import {
		SKILL_FILE_BODY_MAX,
		SKILL_FILES_MAX,
		SKILL_TOTAL_MAX,
		readSkillPicks,
		skillFilePathError,
		skillFilesError
	} from '#lib/shared/skills.js';
	import { cn } from '#lib/ui/cn.js';
	// -- DEP-COMPONENTS -- //
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Trash from '@lucide/svelte/icons/trash';
	// -- COMPONENTS -- //
	import Button from '#lib/ui/Button.svelte';
	import FilePicker from '#lib/ui/FilePicker.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let {
		files = $bindable(),
		body,
		disabled = false,
		loading = false,
		class: extra
	}: {
		/** The supporting files as editable rows. */
		files: DraftFile[];
		/** The skill body, which counts toward the same total as the files. */
		body: string;
		disabled?: boolean;
		/** The files are still being read, so they cannot be edited yet. */
		loading?: boolean;
		class?: string;
	} = $props();

	// -- CONSTANTS -- //

	/** The editor is a form, so every field and its button carry one size. */
	const TEXT = 'text-[15px]';

	// -- STATES -- //

	/** The row whose text is open. One at a time keeps the dialog short. */
	let openId = $state<string | null>(null);
	let problems = $state<string[]>([]);

	// -- REACTIVE STATES -- //

	const total = $derived(body.length + files.reduce((sum, f) => sum + f.body.length, 0));
	/** Why the files and the body do not fit, or an empty string. */
	const summaryError = $derived(
		skillFilesError(
			body,
			files.map((f) => ({ path: f.path.trim(), body: f.body }))
		) ?? ''
	);
	const over = $derived(total > SKILL_TOTAL_MAX || files.length > SKILL_FILES_MAX);

	// -- FUNCTIONS -- //

	/** The message under a row's path field: a bad path, or a path another row already has. */
	function pathError(file: DraftFile): string {
		const path = file.path.trim();
		const bad = skillFilePathError(path);
		if (bad) return bad;
		const twin = files.some(
			(f) => f.id !== file.id && f.path.trim().toLowerCase() === path.toLowerCase()
		);
		return twin ? `"${path}" is already one of the files.` : '';
	}

	/** Adds the picked Markdown files. A file with a path that is already there replaces that file. */
	async function addFiles(picked: File[]) {
		if (!picked.length) return;
		const picks = await Promise.all(
			picked.map(async (f) => ({
				name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
				text: await f.text()
			}))
		);
		const read = readSkillPicks(picks, { needSkill: false });
		problems = read.problems;
		const next = [...files];
		for (const file of read.files) {
			const at = next.findIndex((f) => f.path.trim().toLowerCase() === file.path.toLowerCase());
			if (at >= 0) next[at] = { ...next[at], body: file.body };
			else next.push(newDraft(file));
		}
		files = next;
	}

	function remove(id: string) {
		files = files.filter((f) => f.id !== id);
		if (openId === id) openId = null;
	}
</script>

<!-- SUPPORTING FILES: THE OTHER MARKDOWN FILES OF A SKILL FOLDER, READ BY AN AGENT ONE AT A TIME -->
<section class={cn('flex flex-col gap-3', TEXT, extra)} data-testid="skill-files">
	<div class="flex flex-col gap-1">
		<h3 class="text-sm font-medium text-ink">Supporting files</h3>
		<p class="text-xs text-muted">
			The other Markdown files of a skill, for example design-fit.md. An agent reads each one by its
			path when the skill points to it.
		</p>
	</div>

	{#if files.length}
		<ul class="rounded-lg border border-line bg-surface" data-testid="skill-file-list">
			{#each files as file (file.id)}
				{@const error = pathError(file)}
				<li class="border-b border-line last:border-b-0">
					<div class="flex items-center gap-1 pr-1">
						<button
							type="button"
							class="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-raised"
							aria-expanded={openId === file.id}
							aria-controls={`skill-file-${file.id}`}
							onclick={() => (openId = openId === file.id ? null : file.id)}
						>
							<ChevronDown
								size={16}
								class={cn(
									'shrink-0 text-muted transition-transform motion-reduce:transition-none',
									openId === file.id && 'rotate-180'
								)}
							/>
							<span
								class={cn(
									'min-w-0 flex-1 truncate font-mono text-sm',
									error ? 'text-danger' : 'text-ink'
								)}
							>
								{file.path || 'New file'}
							</span>
							<span class="shrink-0 text-xs text-muted tabular-nums"
								>{file.body.length} characters</span
							>
						</button>
						<Button
							variant="subtle"
							iconOnly
							aria-label={`Remove ${file.path}`}
							disabled={disabled || loading}
							onclick={() => remove(file.id)}
							data-testid="skill-file-remove"
						>
							<Trash size={16} />
						</Button>
					</div>
					{#if openId === file.id}
						<div id={`skill-file-${file.id}`} class="flex flex-col gap-3 px-3 pt-1 pb-3">
							<TextField
								label="Where does this file sit in the skill folder"
								bind:value={file.path}
								disabled={disabled || loading}
								{error}
								hint={error ? undefined : 'For example design-fit.md or refs/forms.md.'}
								class={TEXT}
							/>
							<TextArea
								label="What does it say"
								bind:value={file.body}
								rows={10}
								maxlength={SKILL_FILE_BODY_MAX}
								disabled={disabled || loading}
								class={cn('font-mono', TEXT)}
							/>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if loading}
		<p class="text-sm text-muted">Reading the files...</p>
	{:else}
		<p class="text-sm text-muted">This skill has no supporting files.</p>
	{/if}

	<FilePicker
		label="Add supporting files"
		hint="Markdown files only. A file with the same path replaces the one already here."
		accept=".md,text/markdown"
		multiple
		disabled={disabled || loading}
		onfiles={(picked) => void addFiles(picked)}
		class={TEXT}
	/>

	{#if problems.length}
		<ul
			role="alert"
			class="flex flex-col gap-1 text-sm text-danger"
			data-testid="skill-file-problems"
		>
			{#each problems as problem, i (i)}
				<li>{problem}</li>
			{/each}
		</ul>
	{/if}

	<!-- THE ONE COUNTER FOR THE BODY AND EVERY FILE, SO A SAVE THAT WILL BE REFUSED SAYS WHY BEFORE THE BUTTON IS PRESSED -->
	<p
		class={cn('text-xs tabular-nums', over ? 'font-medium text-danger' : 'text-muted')}
		data-testid="skill-files-counter"
	>
		{files.length} of {SKILL_FILES_MAX} files, {total.toLocaleString('en')} of {SKILL_TOTAL_MAX.toLocaleString(
			'en'
		)} characters in the body and the files together.
	</p>
	{#if summaryError}
		<p role="alert" class="text-sm text-danger" data-testid="skill-files-error">{summaryError}</p>
	{/if}
</section>
