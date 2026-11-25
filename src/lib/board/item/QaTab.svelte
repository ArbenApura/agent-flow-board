<script lang="ts">
	// IMPORTED TYPES
	import type { ItemQa } from '#lib/server/web/itemQa.js';
	// IMPORTED ENVS
	import { page } from '$app/state';
	// IMPORTED MODULES
	import { QA_BASELINE_LABEL, QA_BASELINE_TONE } from '#lib/board/qa/status.js';
	// IMPORTED COMPONENTS
	import QaStatusPill from '#lib/board/qa/QaStatusPill.svelte';
	import TabCard from '#lib/board/item/TabCard.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';

	// -- REQUIRED PROPS -- //

	let { qa }: { qa: ItemQa } = $props();

	// -- REACTIVE STATES -- //

	const base = $derived(`/${page.params.org ?? ''}/${page.params.project ?? ''}`);
	const list = $derived(qa.list ?? []);
</script>

<!-- THE TESTING TAB OF A PLAN: THE QA FEATURES IT TOUCHES, THEIR RESULT BEFORE THE PLAN AND NOW, AND THEIR OPEN BUGS (AFB-20261125-0442) -->
<TabCard title="Testing" padded>
	{#snippet meta()}<span class="text-xs text-muted tabular-nums">{list.length}</span>{/snippet}
	{#if list.length === 0}
		<EmptyState
			kind="items"
			title="This plan touches no QA features."
			text="When a plan changes the code behind a feature on the Testing page, the feature shows here with its result before and after."
		/>
	{:else}
		<ul class="flex flex-col" data-testid="qa-tab">
			{#each list as f (f.key)}
				<li class="flex flex-col gap-2 border-b border-line py-3 last:border-b-0">
					<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
						<a
							href={`${base}/qa/${f.key}`}
							class="min-h-11 min-w-0 flex-1 cursor-pointer content-center text-sm font-medium text-ink hover:underline focus-visible:outline-2"
							><span class="line-clamp-2 [overflow-wrap:anywhere]">{f.name}</span></a
						>
						<span class="flex items-center gap-2 text-xs text-muted">
							Before
							<Badge tone={QA_BASELINE_TONE[f.baseline] ?? 'neutral'}
								>{QA_BASELINE_LABEL[f.baseline] ?? f.baseline}</Badge
							>
						</span>
						<span class="flex items-center gap-2 text-xs text-muted">
							Now
							<QaStatusPill status={f.status} flaky={f.flaky} />
						</span>
					</div>
					{#if f.bugs.length > 0}
						<ul class="flex flex-wrap gap-x-4 gap-y-1">
							{#each f.bugs as b (b.id)}
								<li class="text-sm">
									<a
										href={`${base}/tasks?task=${encodeURIComponent(b.id)}`}
										class="cursor-pointer text-accent-text hover:underline"
										><span class="font-mono text-xs">{b.ref}</span> {b.title}</a
									>
								</li>
							{/each}
						</ul>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</TabCard>
