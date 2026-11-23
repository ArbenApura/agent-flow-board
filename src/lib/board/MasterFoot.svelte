<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { ItemRow } from '#lib/board/rows.js';
	// IMPORTED MODULES
	import ChildBar from '#lib/board/ChildBar.svelte';
	import { childSummary, siblingHref } from '#lib/board/family.js';
	import { STATUS_STYLE, type Status } from '#lib/board/status.js';
	// IMPORTED DEP-COMPONENTS
	import ChevronDown from '@lucide/svelte/icons/chevron-down';

	// -- REQUIRED PROPS -- //

	let {
		row,
		href
	}: {
		/** The master, with its child plans in row.kids. */
		row: ItemRow;
		/** The master's own address, so each child links next to it. */
		href: string;
	} = $props();

	// -- STATES -- //

	let open = $state(false);

	// -- REACTIVE STATES -- //

	const kids = $derived(row.kids ?? []);
	const listId = $derived(`kids-${row.id}`);
</script>

<!-- THE FOOT OF A MASTER CARD: HOW THE CHILD PLANS STAND, ONE SEGMENT EACH, AND A CHEVRON THAT OPENS THEM IN PLACE -->
<div class="border-t border-line px-3.5 py-3 pl-4.5" data-testid="master-foot">
	<div class="flex flex-col gap-2">
		<div class="flex items-center gap-2.5">
			<span class="min-w-0 flex-1 text-xs text-muted tabular-nums">{childSummary(kids)}</span>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={listId}
				aria-label={`Show the child plans of ${row.ref}`}
				onclick={() => (open = !open)}
				class="group inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-line bg-surface text-ink hover:border-muted hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent max-sm:size-11"
			>
				<ChevronDown
					size={16}
					class="transition-transform duration-150 group-aria-expanded:rotate-180 motion-reduce:transition-none"
					aria-hidden="true"
				/>
			</button>
		</div>
		<ChildBar {kids} />
	</div>
	<!-- THE ROWS OPEN BY ANIMATING THE ROW HEIGHT FROM 0 TO ITS CONTENT. CLOSED, THEY CANNOT BE FOCUSED -->
	<div
		id={listId}
		data-open={open}
		inert={!open}
		class="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out data-[open=true]:grid-rows-[1fr] motion-reduce:transition-none"
	>
		<div class="overflow-hidden">
			<ul class="mt-2.5 flex flex-col gap-0.5">
				{#each kids as k (k.id)}
					<li>
						<a
							href={siblingHref(href, k.ref)}
							class="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-1.5 text-xs text-ink hover:bg-raised max-sm:min-h-11"
						>
							<span class="w-5 shrink-0 text-muted tabular-nums">{k.childNo}</span>
							<span class="min-w-0 flex-1 truncate">{k.title}</span>
							<span
								class={'size-2 shrink-0 rounded-full ' + STATUS_STYLE[k.status as Status].dot}
								aria-hidden="true"
							></span>
							<span class="w-10 shrink-0 text-right font-semibold whitespace-nowrap tabular-nums"
								>{k.percent}%</span
							>
						</a>
					</li>
				{/each}
			</ul>
		</div>
	</div>
</div>
