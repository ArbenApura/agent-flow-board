<script lang="ts">
	// -- DEP-TYPES -- //
	import type { PageProps } from './$types';
	import type { ScreenKey } from '#lib/board/mockups.js';
	// -- ENVS -- //
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
	// -- MODULES -- //
	import { ApiError, api, newKey } from '#lib/board/api.js';
	import {
		DEVICE_WORDS,
		LOOK_CHIPS,
		MOCKUP_TABS,
		addChip,
		devicesDirty,
		devicesFromSaved,
		devicesIssue,
		devicesToSave,
		exampleChanges,
		examplesIssue,
		kitRequest,
		kitState,
		readTab,
		suggestionsLeft,
		type DevicesDraft
	} from '#lib/board/mockupSettings.js';
	import { ALL_SCREENS, SCREEN_WIDTH } from '#lib/board/mockups.js';
	import { ago } from '#lib/board/status.js';
	import { canon, createFollower } from '#lib/settings/follow.js';
	import Section from '#lib/settings/Section.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	import Notice from '#lib/ui/Notice.svelte';
	import PageFrame from '#lib/ui/PageFrame.svelte';
	import PageHeader from '#lib/ui/PageHeader.svelte';
	import Popover from '#lib/ui/Popover.svelte';
	import Switch from '#lib/ui/Switch.svelte';
	import TextArea from '#lib/ui/TextArea.svelte';
	import TextField from '#lib/ui/TextField.svelte';
	import { cn } from '#lib/ui/cn.js';
	import { toast } from '#lib/ui/toast.svelte.js';
	// -- DEP-COMPONENTS -- //
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import LayoutTemplate from '@lucide/svelte/icons/layout-template';
	import Laptop from '@lucide/svelte/icons/laptop';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Palette from '@lucide/svelte/icons/palette';
	import Plus from '@lucide/svelte/icons/plus';
	import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import Tablet from '@lucide/svelte/icons/tablet';
	import Trash from '@lucide/svelte/icons/trash';

	// -- TYPES -- //

	type Row = { key: string; name: string; prompt: string };

	// -- REQUIRED PROPS -- //

	let { data }: PageProps = $props();

	// -- CONSTANTS -- //

	const DEVICE_ICON = { wide: Monitor, laptop: Laptop, tablet: Tablet, phone: Smartphone };
	const path = (tail: string) => `/projects/${data.projectKey}/${tail}`;

	// -- STATES -- //

	let tabRow = $state<HTMLElement>();
	// The fields start from the saved values, so the first server rendered page shows them and does not flash empty
	let style = $state(untrack(() => data.settings?.style.text ?? ''));
	let devices = $state<DevicesDraft>(
		untrack(() => devicesFromSaved(data.settings?.screens ?? [], data.settings?.themes ?? []))
	);
	let rows = $state<Row[]>(
		untrack(() =>
			(data.settings?.examples ?? []).map((e, i) => ({
				key: `row-first-${i}`,
				name: e.name,
				prompt: e.prompt
			}))
		)
	);
	let addOpen = $state(false);
	let status = $state<Record<string, { saving: boolean; saved: boolean; error: string }>>({});

	// -- REACTIVE STATES -- //

	const org = $derived(page.params.org ?? '');
	const base = $derived(`/${org}/${page.params.project ?? data.projectKey}`);
	const saved = $derived(data.settings);
	const can = $derived(Boolean(saved?.canManage));
	const tab = $derived(readTab(page.url.searchParams.get('tab')));
	const savedDevices = $derived(devicesFromSaved(saved?.screens ?? [], saved?.themes ?? []));
	const byName = (list: { name: string; prompt: string }[]) =>
		canon(
			list
				.map((r) => [r.name.trim(), r.prompt])
				.sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()))
		);
	const dirty = $derived({
		look: style !== (saved?.style.text ?? ''),
		devices: devicesDirty(devices, savedDevices),
		examples: byName(rows) !== byName(saved?.examples ?? [])
	});
	const devicesProblem = $derived(devicesIssue(devices));
	const examplesProblem = $derived(examplesIssue(rows));
	const suggestions = $derived(suggestionsLeft(rows.map((r) => r.name)));
	const kit = $derived(kitState(saved?.kit ?? null));

	// -- FUNCTIONS -- //

	const st = (id: string) => status[id] ?? { saving: false, saved: false, error: '' };

	let seq = 0;
	const newRow = (name: string, prompt: string): Row => ({ key: `row-${++seq}`, name, prompt });

	/** Runs one save. The saved data is read again even when a call failed, so a half done save never leaves Save stuck. */
	async function run(id: string, work: () => Promise<unknown>) {
		status[id] = { saving: true, saved: false, error: '' };
		let failure = '';
		try {
			await toast.promise(work(), {
				id: `save-${id}`,
				loading: 'Saving...',
				success: 'Saved.',
				error: (e) => (e instanceof ApiError ? e.message : 'That was not saved.')
			});
		} catch (e) {
			failure = e instanceof ApiError ? e.message : 'That was not saved.';
		}
		await invalidate('afb:settings');
		status[id] = { saving: false, saved: !failure, error: failure };
	}

	const saveSettings = (id: string, body: Record<string, unknown>) =>
		run(id, () => api(org, path('mockup-settings'), { method: 'PUT', body, key: newKey() }));

	/** New and changed names are written first, then the names that are gone are deleted. A delete that finds nothing is done. */
	function saveExamples() {
		const { writes, deletes } = exampleChanges(saved?.examples ?? [], rows);
		return run('examples', async () => {
			for (const w of writes)
				await api(org, path('mockup-templates'), { method: 'PUT', body: w, key: newKey() });
			for (const name of deletes) {
				try {
					await api(org, `${path('mockup-templates')}?name=${encodeURIComponent(name)}`, {
						method: 'DELETE',
						key: newKey()
					});
				} catch (e) {
					if (!(e instanceof ApiError && e.status === 404)) throw e;
				}
			}
		});
	}

	function toggleDevice(s: ScreenKey) {
		devices.screens = devices.screens.includes(s)
			? devices.screens.filter((x) => x !== s)
			: [...devices.screens, s];
	}

	async function copyRequest() {
		try {
			await navigator.clipboard.writeText(kitRequest(data.projectName, data.projectKey));
			toast.success('Request copied. Paste it into your coding tool.');
		} catch {
			toast.error('The request could not be copied. Select it and copy by hand.');
		}
	}

	// -- REACTIVE STATEMENTS -- //

	// The fields follow the saved values whenever the page data is replaced, and an edit not saved yet is kept
	const follow = createFollower();
	$effect(() => {
		const s = saved;
		if (!s) return;
		follow('style', s.style.text, (v) => (style = v));
		follow(
			'devices',
			[s.screens, s.themes],
			() => (devices = devicesFromSaved(s.screens, s.themes))
		);
		follow(
			'examples',
			s.examples.map((e) => [e.name, e.prompt]),
			() => (rows = s.examples.map((e) => newRow(e.name, e.prompt)))
		);
	});

	// The open tab slides to the centre of the row, which scrolls sideways on a phone
	$effect(() => {
		void tab;
		const row = tabRow;
		const active = row?.querySelector<HTMLElement>('[aria-current="page"]');
		if (!row || !active) return;
		const left =
			active.getBoundingClientRect().left -
			row.getBoundingClientRect().left +
			row.scrollLeft -
			(row.clientWidth - active.offsetWidth) / 2;
		row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
	});
</script>

<svelte:head><title>Mockup settings, {data.projectName}</title></svelte:head>

<PageFrame class="pb-12">
	<PageHeader
		title="Mockup settings"
		back={{ href: `${base}/mockups`, label: 'Back to the mockups' }}
		context="Tell your coding tool how mockups should look. Every tab works if you leave it empty."
	/>

	{#if !saved}
		<EmptyState
			kind="locked"
			title="Not available"
			text="You do not have access to this project."
		/>
	{:else}
		<div class="flex flex-col gap-4">
			{#if !can}
				<Notice tone="info"
					>Only admins and owners change these settings. You can read them here.</Notice
				>
			{/if}

			<!-- THE FOUR TABS, KEPT IN THE ADDRESS. THEY ARE LINKS, SO A CLICK CHANGES ONLY THE ADDRESS AND NOTHING IS LOADED AGAIN -->
			<nav
				bind:this={tabRow}
				aria-label="Mockup settings"
				class="flex [scrollbar-width:none]! gap-0.5 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-line [&::-webkit-scrollbar]:hidden"
			>
				{#each MOCKUP_TABS as t (t.id)}
					<a
						href={`?tab=${t.id}`}
						data-sveltekit-replacestate
						data-sveltekit-noscroll
						data-sveltekit-keepfocus
						aria-current={tab === t.id ? 'page' : undefined}
						data-testid={`tab-${t.id}`}
						class={cn(
							'-mb-px inline-flex min-h-11 shrink-0 cursor-pointer items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap',
							tab === t.id
								? 'border-accent text-accent-text'
								: 'border-transparent text-muted hover:text-ink'
						)}>{t.label}</a
					>
				{/each}
			</nav>

			<!-- ALL FOUR STAY MOUNTED AND THE CLOSED ONES ARE HIDDEN, SO WHAT SOMEONE TYPED SURVIVES A LOOK AT ANOTHER TAB -->
			<div hidden={tab !== 'look'}>
				<Section
					id="look"
					icon={Palette}
					title="Look and feel"
					text="Describe the mood of your product in a few words. Your coding tool reads this before it draws a mockup."
					dirty={dirty.look}
					saving={st('look').saving}
					saved={st('look').saved}
					error={st('look').error}
					readonly={!can}
					onsave={() => saveSettings('look', { style })}
				>
					<p class="text-sm text-muted">
						If you leave this empty, mockups follow your colours and fonts and nothing else.
					</p>
					<TextArea
						label="Describe the look"
						placeholder="Example: calm and roomy, soft corners, one accent colour."
						rows={6}
						bind:value={style}
						maxlength={20000}
						disabled={!can}
						data-testid="look-input"
					/>
					{#if can}
						<div class="flex flex-col gap-2">
							<p class="text-xs font-medium text-ink">Need a start? Tap one to add it.</p>
							<div class="flex flex-wrap gap-2">
								{#each LOOK_CHIPS as c (c.label)}
									<button
										type="button"
										onclick={() => (style = addChip(style, c.text))}
										class="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-line bg-raised px-3 text-xs font-medium text-ink hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
										>{c.label}</button
									>
								{/each}
							</div>
						</div>
					{/if}
				</Section>
			</div>

			<div hidden={tab !== 'devices'}>
				<Section
					id="devices"
					icon={Smartphone}
					title="Devices"
					text="Choose the devices a mockup is shown on. People switch between them when they look at a mockup."
					dirty={dirty.devices}
					blocked={Boolean(devicesProblem)}
					saving={st('devices').saving}
					saved={st('devices').saved}
					error={devicesProblem ?? st('devices').error}
					readonly={!can}
					onsave={() => saveSettings('devices', devicesToSave(devices))}
				>
					<p class="text-sm text-muted">
						If you leave this alone, all four devices and both colour modes are on.
					</p>
					<div
						class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 max-sm:grid-cols-1"
						role="group"
						aria-label="Devices"
					>
						{#each ALL_SCREENS as s (s)}
							{@const Icon = DEVICE_ICON[s]}
							{@const on = devices.screens.includes(s)}
							<button
								type="button"
								role="checkbox"
								aria-checked={on}
								disabled={!can}
								onclick={() => toggleDevice(s)}
								data-testid={`device-${s}`}
								class={cn(
									'flex min-h-16 cursor-pointer items-center gap-3 rounded-xl border p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60',
									on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-muted'
								)}
							>
								<span
									class={cn(
										'inline-flex size-10 shrink-0 items-center justify-center rounded-lg',
										on ? 'bg-surface text-accent-text' : 'bg-raised text-muted'
									)}
									aria-hidden="true"><Icon size={20} /></span
								>
								<span class="flex min-w-0 flex-1 flex-col">
									<span class="text-sm font-semibold text-ink">{DEVICE_WORDS[s]}</span>
									<span class="text-xs text-muted">{SCREEN_WIDTH[s]} px wide</span>
								</span>
								<span
									class={cn(
										'inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] border-[1.5px]',
										on ? 'border-accent bg-accent text-accent-ink' : 'border-muted bg-surface'
									)}
									aria-hidden="true"
								>
									{#if on}<Check size={14} strokeWidth={3} />{/if}
								</span>
							</button>
						{/each}
					</div>
					<div class="flex flex-col">
						<Switch label="Show in light mode" bind:checked={devices.light} disabled={!can} />
						<Switch label="Show in dark mode" bind:checked={devices.dark} disabled={!can} />
					</div>
				</Section>
			</div>

			<div hidden={tab !== 'examples'}>
				<Section
					id="examples"
					icon={LayoutTemplate}
					title="Page examples"
					text="A page example is a starting point, such as a settings page or a list page. Your coding tool can pick one when it draws a mockup."
					dirty={dirty.examples}
					blocked={Boolean(examplesProblem)}
					saving={st('examples').saving}
					saved={st('examples').saved}
					error={examplesProblem ?? st('examples').error}
					readonly={!can}
					onsave={saveExamples}
				>
					<p class="text-sm text-muted">
						It is fine to have none. Mockups then start from a plain page.
					</p>
					{#if can}
						<div>
							<Popover bind:open={addOpen} role="menu" label="Add an example">
								{#snippet trigger({ props, toggle })}
									<Button onclick={toggle} data-testid="add-example" {...props}>
										<Plus size={16} /> Add an example
									</Button>
								{/snippet}
								{#snippet children({ close })}
									<div role="presentation">
										{#each suggestions as s (s)}
											<button
												type="button"
												role="menuitem"
												onclick={() => {
													rows = [...rows, newRow(s, '')];
													close();
												}}
												class="flex min-h-11 w-full cursor-pointer items-center rounded-md px-2.5 text-left text-sm text-ink hover:bg-raised focus-visible:bg-raised focus-visible:outline-none"
												>{s}</button
											>
										{/each}
										<button
											type="button"
											role="menuitem"
											onclick={() => {
												rows = [...rows, newRow('', '')];
												close();
											}}
											class="flex min-h-11 w-full cursor-pointer items-center rounded-md px-2.5 text-left text-sm text-ink hover:bg-raised focus-visible:bg-raised focus-visible:outline-none"
											>Blank example</button
										>
									</div>
								{/snippet}
							</Popover>
						</div>
					{/if}
					<ul class="flex flex-col gap-3" data-testid="examples">
						{#each rows as r (r.key)}
							<li class="flex flex-col gap-2 rounded-xl border border-line p-3">
								<div class="flex items-end gap-2">
									<TextField
										label="Example name"
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
											aria-label={`Remove ${r.name || 'this example'}`}
											onclick={() => (rows = rows.filter((x) => x.key !== r.key))}
										>
											<Trash size={18} />
										</Button>
									{/if}
								</div>
								<TextArea
									label="What is on this page"
									placeholder="A sidebar, a title band and one card with a form."
									rows={3}
									bind:value={r.prompt}
									disabled={!can}
									maxlength={20000}
								/>
							</li>
						{/each}
					</ul>
					{#if rows.length === 0}<p class="text-sm text-muted">No examples yet.</p>{/if}
				</Section>
			</div>

			<div hidden={tab !== 'colours'}>
				<Section
					id="colours"
					icon={SlidersHorizontal}
					title="Colours and fonts"
					text="This is the board's copy of your product's colours, fonts, logo and icons, so mockups look like your product. Your coding tool makes it from your code."
				>
					<p class="text-sm text-muted">
						If it is not made yet, mockups use a plain look until your coding tool makes one.
					</p>
					<div class="flex flex-wrap items-center gap-2" data-testid="kit-state">
						<Badge tone={kit.tone}>{kit.label}</Badge>
						<span class="text-sm text-muted">{kit.line}</span>
					</div>
					{#if saved.kit}
						<dl class="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-sm max-sm:grid-cols-1">
							<dt class="text-xs font-medium text-muted">Made from</dt>
							<dd class="text-ink">
								<span class="font-mono text-xs"
									>{saved.kit.builtFromCommit || 'an unknown commit'}</span
								>, {ago(saved.kit.builtAt)}{saved.kit.builtBy ? `, by ${saved.kit.builtBy}` : ''}
							</dd>
							{#if saved.kit.summary}
								<dt class="text-xs font-medium text-muted">What is in it</dt>
								<!-- PLAIN TEXT ONLY: THE SUMMARY WAS WRITTEN BY THE TOOL THAT MADE IT -->
								<dd class="[overflow-wrap:anywhere] whitespace-pre-wrap text-ink">
									{saved.kit.summary}
								</dd>
							{/if}
						</dl>
					{/if}
					<div>
						<Button variant="primary" onclick={copyRequest} data-testid="copy-request">
							<Copy size={16} /> Copy a request for your coding tool
						</Button>
					</div>
				</Section>
			</div>
		</div>
	{/if}
</PageFrame>
