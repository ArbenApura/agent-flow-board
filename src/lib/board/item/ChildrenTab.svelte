<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { ItemView } from '#lib/board/item/types.js';
	// IMPORTED ENVS
	import { page } from '$app/state';
	// IMPORTED MODULES
	import ChildBar from '#lib/board/ChildBar.svelte';
	import { childCounts } from '#lib/board/family.js';
	import { STATUS_STYLE, statusLabel, type Status } from '#lib/board/status.js';
	import Button from '#lib/ui/Button.svelte';
	import Progress from '#lib/ui/Progress.svelte';
	import EmptyState from '#lib/ui/EmptyState.svelte';
	// IMPORTED DEP-COMPONENTS
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';

	// -- REQUIRED PROPS -- //

	let { detail }: { detail: ItemView } = $props();

	// -- CONSTANTS -- //

	/** The groups in the order they are read: what is moving first, what is finished last (and folded away). */
	const GROUPS: Status[] = [
		'IN PROGRESS',
		'IN REVIEW',
		'ON HOLD',
		'PLANNED',
		'COMPLETED',
		'REMOVED'
	];
	/** These groups start closed behind a chevron. */
	const FOLDED: Status[] = ['COMPLETED', 'REMOVED'];

	// -- STATES -- //

	let openGroups = $state<Record<string, boolean>>({});

	// -- REACTIVE STATES -- //

	const kids = $derived(detail.family.kids[detail.item.id] ?? []);
	const base = $derived(`/${page.params.org}/${page.params.project}`);
	const counts = $derived(childCounts(kids));
	const stepsDone = $derived(kids.reduce((sum, k) => sum + k.doneSteps, 0));
	const stepsTotal = $derived(kids.reduce((sum, k) => sum + k.totalSteps, 0));
	const groups = $derived(
		GROUPS.map((status) => ({ status, list: kids.filter((k) => k.status === status) })).filter(
			(g) => g.list.length > 0
		)
	);
	/** The first child plan that is not finished, in child order. */
	const next = $derived(kids.find((k) => k.status === 'IN PROGRESS' || k.status === 'PLANNED'));
	/** The legend names the three statuses of the mockup, and any other status a child plan really holds. */
	const legend = $derived(
		(['COMPLETED', 'IN PROGRESS', 'IN REVIEW', 'ON HOLD', 'PLANNED', 'REMOVED'] as Status[])
			.map((status) => ({ status, n: kids.filter((k) => k.status === status).length }))
			.filter(
				(l) =>
					l.n > 0 ||
					l.status === 'COMPLETED' ||
					l.status === 'IN PROGRESS' ||
					l.status === 'PLANNED'
			)
	);
</script>

{#if kids.length === 0}
	<EmptyState
		kind="search"
		title="No child plans yet"
		text="A child plan is a piece of this plan that ships or is reviewed on its own, or runs in parallel with another."
	/>
{:else}
	<!-- TWO PARTS: THE CHILD PLANS GROUPED BY STATUS, AND A ROADMAP CARD THAT STAYS IN VIEW. ON A PHONE THE ROADMAP COMES FIRST -->
	<div
		class="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]"
		data-testid="children-tab"
	>
		<section
			class="flex flex-col gap-5 rounded-xl border border-line bg-surface p-3 shadow-[var(--elev-1)]"
			aria-label="Child plans"
			data-testid="children-list"
		>
			<h2 class="px-3 pt-2 text-lg font-semibold">Child plans</h2>
			{#each groups as g (g.status)}
				{@const folded = FOLDED.includes(g.status)}
				{@const open = !folded || !!openGroups[g.status]}
				<section aria-label={statusLabel(g.status)}>
					<!-- THE GROUP NAME LOOKS LIKE A COLUMN HEAD OF THE BOARD: DOT, UPPERCASE NAME, COUNT -->
					<header class="flex items-center gap-2 px-3 pb-1">
						<span class={'size-2 rounded-full ' + STATUS_STYLE[g.status].dot} aria-hidden="true"
						></span>
						<h3 class="text-badge font-bold tracking-wider text-ink uppercase">{g.status}</h3>
						<span
							class="rounded-full border border-line bg-raised px-2 text-badge font-semibold text-muted tabular-nums"
							>{g.list.length}</span
						>
						{#if folded}
							<button
								type="button"
								aria-expanded={open}
								aria-controls={`group-${g.status}`}
								aria-label={`Show the ${statusLabel(g.status).toLowerCase()} child plans`}
								onclick={() => (openGroups[g.status] = !open)}
								class="group ml-auto inline-flex size-8 cursor-pointer items-center justify-center rounded-lg border border-line bg-surface text-ink hover:border-muted hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent max-sm:size-11"
							>
								<ChevronDown
									size={16}
									class="transition-transform duration-150 group-aria-expanded:rotate-180 motion-reduce:transition-none"
									aria-hidden="true"
								/>
							</button>
						{/if}
					</header>
					<div
						id={`group-${g.status}`}
						data-open={open}
						inert={!open}
						class="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out data-[open=true]:grid-rows-[1fr] motion-reduce:transition-none"
					>
						<div class="flex flex-col overflow-hidden">
							{#each g.list as k (k.id)}
								<!-- ONE ROW: NUMBER, TITLE WITH ITS REFERENCE, PROGRESS. THE STATUS IS THE GROUP, SO THERE IS NO PILL -->
								<a
									href={`${base}/${k.ref}`}
									data-testid="child-row"
									class="flex cursor-pointer items-center gap-4 rounded-lg px-3 py-2.5 hover:bg-raised max-sm:flex-wrap max-sm:gap-y-2"
								>
									<span class="w-5 shrink-0 text-sm font-semibold text-muted tabular-nums"
										>{k.childNo}</span
									>
									<span class="flex min-w-0 flex-1 flex-col max-sm:basis-[calc(100%-2.25rem)]">
										<span class="truncate text-sm font-semibold text-ink">{k.title}</span>
										<span class="font-mono text-xs text-muted">{k.ref}</span>
									</span>
									<span class="flex w-56 shrink-0 items-center gap-2.5 max-sm:w-full max-sm:pl-9">
										<Progress
											value={k.percent}
											label={`Child ${k.childNo} progress`}
											fill={STATUS_STYLE[k.status as Status].rail}
										/>
										<span
											class="w-10 shrink-0 text-right text-xs font-semibold whitespace-nowrap tabular-nums"
											>{k.percent}%</span
										>
										<span
											class="w-20 shrink-0 text-right text-xs whitespace-nowrap text-muted tabular-nums max-sm:hidden"
											>{k.doneSteps} of {k.totalSteps}</span
										>
									</span>
								</a>
							{/each}
						</div>
					</div>
				</section>
			{/each}
		</section>

		<!-- THE ROADMAP CARD: HOW MANY PLANS ARE DONE, THE BAR, THE COUNTS, THE STEPS, AND WHAT IS NEXT. BELOW 1536 PX THE TAB BAR STICKS ABOVE IT, SO IT STICKS LOWER -->
		<aside
			class="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-[var(--elev-1)] max-lg:order-first max-sm:p-4 lg:sticky lg:top-[141px] 2xl:top-[89px]"
			aria-label="Roadmap"
			data-testid="children-roadmap"
		>
			<div class="flex items-baseline gap-1.5">
				<span class="text-lg font-semibold tabular-nums">{counts.done} of {counts.n}</span>
				<span class="text-sm text-muted">plans done</span>
			</div>
			<ChildBar {kids} />
			<ul class="flex flex-col gap-2 text-sm">
				{#each legend as l (l.status)}
					<li class="flex items-center gap-2.5">
						<span
							class={'size-2 shrink-0 rounded-full ' + STATUS_STYLE[l.status].dot}
							aria-hidden="true"
						></span>
						<span class="flex-1 text-muted">{statusLabel(l.status)}</span>
						<span class="font-semibold tabular-nums">{l.n}</span>
					</li>
				{/each}
			</ul>
			<div class="flex items-center justify-between border-t border-line pt-3 text-sm">
				<span class="text-muted">Steps</span>
				<span class="font-semibold tabular-nums">{stepsDone} of {stepsTotal}</span>
			</div>
			{#if next}
				<div class="flex flex-col gap-2 border-t border-line pt-4" data-testid="next-up">
					<span class="text-xs font-medium text-muted">Next up</span>
					<span class="text-sm font-semibold text-ink">{next.childNo} · {next.title}</span>
					<span class="font-mono text-xs text-muted">{next.ref}</span>
					<span class="flex items-center gap-2.5">
						<Progress
							value={next.percent}
							label={`Child ${next.childNo} progress`}
							fill={STATUS_STYLE[next.status as Status].rail}
						/>
						<span
							class="w-10 shrink-0 text-right text-xs font-semibold whitespace-nowrap tabular-nums"
							>{next.percent}%</span
						>
					</span>
					<Button href={`${base}/${next.ref}`} class="mt-1 w-full">
						Open plan <ChevronRight size={16} aria-hidden="true" />
					</Button>
				</div>
			{/if}
		</aside>
	</div>
{/if}
