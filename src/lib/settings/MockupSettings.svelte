<script lang="ts">
	// -- DEP-TYPES -- //
	import type { ScreenKey } from '#lib/board/mockups.js';
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import { ALL_SCREENS, SCREEN_LABEL, SCREEN_WIDTH, screensOf } from '#lib/board/mockups.js';
	import { ago } from '#lib/board/status.js';
	import { canon, createFollower } from '#lib/settings/follow.js';
	import Section from '#lib/settings/Section.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Checkbox from '#lib/ui/Checkbox.svelte';
	import TagInput from '#lib/ui/TagInput.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Copy from '@lucide/svelte/icons/copy';
	import LayoutTemplate from '@lucide/svelte/icons/layout-template';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Package from '@lucide/svelte/icons/package';
	import Palette from '@lucide/svelte/icons/palette';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash from '@lucide/svelte/icons/trash';

	// -- TYPES -- //

	type Saved = {
		style: { text: string; updatedBy: string | null; updatedAt: string | Date | null };
		screens: string[];
		themes: string[];
		templates: { id: string; name: string; prompt: string; updatedBy: string | null }[];
		kit: {
			number: number;
			builtFromCommit: string;
			builtAt: string | Date;
			summary: string;
			stale: boolean;
			builtBy: string | null;
		} | null;
	};
	type Row = { key: string; name: string; prompt: string; was: string | null };

	// -- REQUIRED PROPS -- //

	let {
		saved,
		org,
		projectKey,
		projectName,
		can
	}: { saved: Saved; org: string; projectKey: string; projectName: string; can: boolean } =
		$props();

	// -- CONSTANTS -- //

	const GROUP = 'Mockups';
	const path = (tail: string) => `/projects/${projectKey}/${tail}`;

	// -- STATES -- //

	let style = $state('');
	let screens = $state<ScreenKey[]>([]);
	let themes = $state<string[]>([]);
	let rows = $state<Row[]>([]);
	let status = $state<Record<string, { saving: boolean; saved: boolean; error: string }>>({});

	// -- REACTIVE STATES -- //

	const st = (id: string) => status[id] ?? { saving: false, saved: false, error: '' };
	const dirty = $derived({
		style: style !== saved.style.text,
		templates: canon(rows.map((r) => [r.name.trim(), r.prompt, r.was])) !== canon(savedRows(saved)),
		screens:
			canon(ALL_SCREENS.filter((s) => screens.includes(s))) !== canon(screensOf(saved.screens)) ||
			canon(themes) !== canon(saved.themes)
	});
	const names = $derived(rows.map((r) => r.name.trim().toLowerCase()));
	const templatesIssue = $derived(
		rows.some((r) => !r.name.trim())
			? 'Every template needs a name.'
			: new Set(names).size !== names.length
				? 'Two templates have the same name.'
				: null
	);
	const screensIssue = $derived(screens.length === 0 ? 'Pick at least one screen.' : null);
	const kit = $derived(saved.kit);

	// -- FUNCTIONS -- //

	function savedRows(s: Saved): (string | null)[][] {
		return s.templates.map((t) => [t.name, t.prompt, t.name]);
	}

	let seq = 0;
	const newRow = (name: string, prompt: string, was: string | null): Row => ({
		key: `row-${++seq}`,
		name,
		prompt,
		was
	});

	async function run(id: string, work: () => Promise<unknown>) {
		status[id] = { saving: true, saved: false, error: '' };
		try {
			await toast.promise(work(), {
				id: `save-${id}`,
				loading: 'Saving...',
				success: 'Saved.',
				error: (e) => (e instanceof ApiError ? e.message : 'That was not saved.')
			});
		} catch (e) {
			status[id] = {
				saving: false,
				saved: false,
				error: e instanceof ApiError ? e.message : 'That was not saved.'
			};
			return;
		}
		await invalidate('afb:settings');
		status[id] = { saving: false, saved: true, error: '' };
	}

	const saveSettings = (id: string, body: Record<string, unknown>) =>
		run(id, () => api(org, path('mockup-settings'), { method: 'PUT', body, key: newKey() }));

	/** Sends what changed: a new or edited template is saved by name, a renamed one removes its old name, a removed one is deleted. */
	function saveTemplates() {
		return run('templates', async () => {
			const keep = new Set(rows.map((r) => r.name.trim()));
			for (const t of saved.templates)
				if (!keep.has(t.name))
					await api(org, `${path('mockup-templates')}?name=${encodeURIComponent(t.name)}`, {
						method: 'DELETE',
						key: newKey()
					});
			for (const r of rows) {
				const s = saved.templates.find((t) => t.name === r.name.trim());
				if (s && s.prompt === r.prompt) continue;
				await api(org, path('mockup-templates'), {
					method: 'PUT',
					body: { name: r.name.trim(), prompt: r.prompt },
					key: newKey()
				});
			}
		});
	}

	async function copyRebuildPrompt() {
		try {
			await navigator.clipboard.writeText(
				`Rebuild the mockup kit for ${projectName} (project ${projectKey}). Read the design files in the repo (tokens, fonts, logo, icons and the shell and component markup), build one HTML kit, and save it to the board with mockup_kit_set, with the commit it was built from.`
			);
			toast.success('Prompt copied. Paste it into your coding tool.');
		} catch {
			toast.error('The prompt could not be copied. Select it and copy by hand.');
		}
	}

	// -- REACTIVE STATEMENTS -- //

	// The fields follow the saved values whenever the page data is replaced, and an edit not saved yet is kept
	const follow = createFollower();
	$effect(() => {
		follow('style', saved.style.text, (v) => (style = v));
		follow('screens', screensOf(saved.screens), (v) => (screens = [...v]));
		follow('themes', saved.themes, (v) => (themes = [...v]));
		follow(
			'templates',
			saved.templates,
			(v) => (rows = v.map((t) => newRow(t.name, t.prompt, t.name)))
		);
	});
</script>

<Section
	id="mockup-style"
	group={GROUP}
	icon={Palette}
	title="Mockup style"
	text="Plain words your tools read before they draw a mockup: tone, density and what to avoid."
	dirty={dirty.style}
	saving={st('style').saving}
	saved={st('style').saved}
	error={st('style').error}
	readonly={!can}
	onsave={() => saveSettings('style', { style })}
>
	<TextArea
		label="How should this project's mockups look and feel?"
		hint="Colours, fonts and icons come from the project kit, so say things like calm or busy, roomy or dense, and what never to draw."
		rows={8}
		bind:value={style}
		maxlength={20000}
		disabled={!can}
		data-testid="mockup-style-input"
	/>
	{#if saved.style.updatedBy}
		<p class="text-xs text-muted">
			Last changed by {saved.style.updatedBy}{saved.style.updatedAt
				? `, ${ago(saved.style.updatedAt)}`
				: ''}.
		</p>
	{/if}
</Section>

<Section
	id="mockup-templates"
	group={GROUP}
	icon={LayoutTemplate}
	title="Page templates"
	text="Named starting points, such as a settings page or a list page. Your tool picks one that fits."
	dirty={dirty.templates}
	blocked={Boolean(templatesIssue)}
	saving={st('templates').saving}
	saved={st('templates').saved}
	error={templatesIssue ?? st('templates').error}
	readonly={!can}
	onsave={saveTemplates}
>
	<ul class="flex flex-col gap-4" data-testid="mockup-templates">
		{#each rows as r (r.key)}
			<li class="flex flex-col gap-2 rounded-lg border border-line p-3">
				<div class="flex items-end gap-2">
					<TextField
						label="Template name"
						placeholder="Settings page"
						bind:value={r.name}
						disabled={!can}
						maxlength={80}
						class="min-w-0 flex-1"
					/>
					{#if can}
						<Button
							iconOnly
							variant="subtle"
							aria-label={`Remove ${r.name || 'this template'}`}
							onclick={() => (rows = rows.filter((x) => x.key !== r.key))}
						>
							<Trash size={18} />
						</Button>
					{/if}
				</div>
				<TextArea
					label="What this page has"
					placeholder="A sidebar, a title band and one card with a form."
					rows={3}
					bind:value={r.prompt}
					disabled={!can}
					maxlength={20000}
				/>
				{#if r.was && saved.templates.find((t) => t.name === r.was)?.updatedBy}
					<p class="text-xs text-muted">
						Last changed by {saved.templates.find((t) => t.name === r.was)?.updatedBy}.
					</p>
				{/if}
			</li>
		{/each}
	</ul>
	{#if rows.length === 0}<p class="text-sm text-muted">No templates yet.</p>{/if}
	{#if can}
		<div>
			<Button onclick={() => (rows = [...rows, newRow('', '', null)])} data-testid="add-template">
				<Plus size={16} /> Add a template
			</Button>
		</div>
	{/if}
</Section>

<Section
	id="mockup-screens"
	group={GROUP}
	icon={Monitor}
	title="Screens and themes"
	text="The widths a mockup is drawn at, and the colour modes it shows."
	dirty={dirty.screens}
	blocked={Boolean(screensIssue)}
	saving={st('screens').saving}
	saved={st('screens').saved}
	error={screensIssue ?? st('screens').error}
	readonly={!can}
	onsave={() =>
		saveSettings('screens', { screens: ALL_SCREENS.filter((s) => screens.includes(s)), themes })}
>
	<fieldset class="flex flex-col" disabled={!can}>
		<legend class="mb-1 text-xs font-medium text-ink"
			>Which screens should every mockup be drawn for?</legend
		>
		{#each ALL_SCREENS as s (s)}
			<Checkbox
				label={`${SCREEN_LABEL[s]}, ${SCREEN_WIDTH[s]} px`}
				checked={screens.includes(s)}
				disabled={!can}
				onchange={(e) =>
					(screens = e.currentTarget.checked ? [...screens, s] : screens.filter((x) => x !== s))}
			/>
		{/each}
	</fieldset>
	<TagInput
		label="Which colour modes should it show?"
		hint="Usually light and dark, from the project kit. Type a name and press Enter."
		placeholder="light"
		bind:tags={themes}
		disabled={!can}
		removeLabel={(t) => `Remove the ${t} mode`}
	/>
</Section>

<Section
	id="mockup-kit"
	group={GROUP}
	icon={Package}
	title="Project kit"
	text="The colours, fonts, logo, icons and component markup your tools draw with. They build it from the repo."
	readonly={!can}
>
	<div class="flex flex-col gap-3" data-testid="mockup-kit">
		{#if kit}
			<div class="flex flex-wrap items-center gap-2">
				{#if kit.stale}
					<Badge tone="warning">Out of date</Badge>
				{:else}
					<Badge tone="success">Up to date</Badge>
				{/if}
				<span class="text-sm text-muted">
					Version {kit.number}, built from
					<span class="font-mono text-xs">{kit.builtFromCommit || 'an unknown commit'}</span>,
					{ago(kit.builtAt)}{kit.builtBy ? `, by ${kit.builtBy}` : ''}.
				</span>
			</div>
			{#if kit.summary}
				<!-- PLAIN TEXT ONLY: THE SUMMARY WAS WRITTEN BY THE TOOL THAT BUILT THE KIT -->
				<p class="text-sm [overflow-wrap:anywhere] whitespace-pre-wrap text-ink">{kit.summary}</p>
			{/if}
			{#if kit.stale}
				<p class="text-sm text-muted">
					The design files changed since this kit was built. Your tool rebuilds it before the next
					mockup.
				</p>
			{/if}
		{:else}
			<p class="text-sm text-muted">
				No kit yet. Your tool builds one from the repo when it makes the first mockup.
			</p>
		{/if}
		<div>
			<Button onclick={copyRebuildPrompt} data-testid="copy-rebuild">
				<Copy size={16} /> Copy the rebuild prompt
			</Button>
		</div>
	</div>
</Section>
