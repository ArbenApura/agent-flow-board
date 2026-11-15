<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Component } from 'svelte';
	// IMPORTED TYPES
	import type { SkillIcon, SkillKind } from '#lib/connect/skillKinds.js';
	// IMPORTED MODULES
	import { filterSkills, skillInfo, SKILL_KINDS } from '#lib/connect/skillKinds.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import ClipboardList from '@lucide/svelte/icons/clipboard-list';
	import Compass from '@lucide/svelte/icons/compass';
	import FileText from '@lucide/svelte/icons/file-text';
	import FlaskConical from '@lucide/svelte/icons/flask-conical';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import MessagesSquare from '@lucide/svelte/icons/messages-square';
	import PencilRuler from '@lucide/svelte/icons/pencil-ruler';
	import Route from '@lucide/svelte/icons/route';
	import ScanSearch from '@lucide/svelte/icons/scan-search';
	import Search from '@lucide/svelte/icons/search';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	// IMPORTED COMPONENTS
	import Badge from '#lib/ui/Badge.svelte';
	import Card from '#lib/ui/Card.svelte';
	import TextField from '#lib/ui/TextField.svelte';

	// -- REQUIRED PROPS -- //

	let {
		skills
	}: { skills: { name: string; version: string; description: string; files: number }[] } = $props();

	// -- CONSTANTS -- //

	const ICONS: Record<SkillIcon, Component<{ size?: number }>> = {
		route: Route,
		'list-checks': ListChecks,
		'messages-square': MessagesSquare,
		'scan-search': ScanSearch,
		'clipboard-list': ClipboardList,
		'shield-check': ShieldCheck,
		'flask-conical': FlaskConical,
		'pencil-ruler': PencilRuler,
		compass: Compass,
		sparkles: Sparkles
	};

	// -- STATES -- //

	let term = $state('');
	let kind = $state<'All' | SkillKind>('All');

	// -- REACTIVE STATES -- //

	const rows = $derived(skills.map((s) => ({ ...s, ...skillInfo(s.name, s.description) })));
	// The chips offered are the kinds that hold a skill, in the usual order, and Other only when a skill has no kind yet
	const kinds = $derived(
		[...SKILL_KINDS, 'Other' as const]
			.map((k) => ({ key: k, count: rows.filter((r) => r.kind === k).length }))
			.filter((k) => k.count > 0)
	);
	const shown = $derived(filterSkills(rows, kind, term));
</script>

<!-- FIND A SKILL: A SEARCH AND A FILTER BY KIND, KEPT IN THE PAGE, NOT IN THE ADDRESS. THEN ONE CARD PER SKILL -->
<div class="flex flex-col gap-3 sm:flex-row sm:items-center" data-testid="skills-toolbar">
	<div class="sm:w-72">
		<TextField
			label="Find a skill"
			hideLabel
			icon={Search}
			type="search"
			placeholder="Find a skill"
			autocomplete="off"
			bind:value={term}
		/>
	</div>
	<!-- A SIDEWAYS ROW OF CHIPS: NO SCROLLBAR, NO VERTICAL SCROLL -->
	<div
		class="-m-1 flex min-w-0 flex-1 [scrollbar-width:none]! gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain p-1 [&::-webkit-scrollbar]:hidden"
		role="radiogroup"
		aria-label="Kind of skill"
	>
		{#each [{ key: 'All' as const, count: rows.length }, ...kinds] as k (k.key)}
			<button
				type="button"
				role="radio"
				aria-checked={kind === k.key}
				onclick={() => (kind = k.key)}
				class={cn(
					'inline-flex min-h-10 shrink-0 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors max-sm:min-h-11',
					kind === k.key
						? 'border-accent bg-accent-soft text-accent-text'
						: 'border-line bg-surface text-ink hover:border-muted'
				)}
			>
				{k.key}<span class="text-xs text-muted tabular-nums">{k.count}</span>
			</button>
		{/each}
	</div>
</div>

{#if shown.length === 0}
	<Card padded={false}>
		<div class="flex items-center gap-4 px-4 py-5 max-sm:px-3.5">
			<span
				class="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised text-muted"
				aria-hidden="true"><Search size={18} /></span
			>
			<div>
				<p class="text-sm font-medium text-ink">No skill matches</p>
				<p class="text-sm text-muted">Try another word, or choose All.</p>
			</div>
		</div>
	</Card>
{:else}
	<ul class="stagger grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="skills-list">
		{#each shown as s, i (s.name)}
			{@const Icon = ICONS[s.icon]}
			<li
				style="--i:{i}"
				class="lift flex min-h-11 flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)] max-sm:p-3.5"
			>
				<div class="flex items-start gap-3">
					<span
						class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
						aria-hidden="true"><Icon size={18} /></span
					>
					<div class="min-w-0 flex-1">
						<p class="truncate font-mono text-sm font-semibold text-ink">/{s.name}</p>
						<p class="text-xs text-muted">{s.kind}</p>
					</div>
					<Badge class="font-mono">{s.version}</Badge>
				</div>
				<p class="line-clamp-3 text-sm text-muted">{s.summary}</p>
				<p class="mt-auto flex items-center gap-1.5 text-xs text-muted">
					<FileText size={14} class="shrink-0" aria-hidden="true" />{s.files}
					{s.files === 1 ? 'file' : 'files'}
				</p>
			</li>
		{/each}
	</ul>
{/if}
