<script lang="ts">
	// IMPORTED TYPES
	import type { QaMapFeature, QaStatus, QaTreeNode } from '#lib/board/qa/status.js';
	// IMPORTED MODULES
	import { QA_STATUS_LABEL, qaCounts, qaPlural, qaStatusOf } from '#lib/board/qa/status.js';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Copy from '@lucide/svelte/icons/copy';
	// IMPORTED COMPONENTS
	import QaAreaGroup from '#lib/board/qa/QaAreaGroup.svelte';
	import QaFeatureRow from '#lib/board/qa/QaFeatureRow.svelte';
	import QaHealthBar from '#lib/board/qa/QaHealthBar.svelte';
	import QaStatusDot from '#lib/board/qa/QaStatusDot.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Tooltip from '#lib/ui/Tooltip.svelte';

	// -- REQUIRED PROPS -- //

	let {
		node,
		base,
		collapsed,
		ontoggle,
		oncopy
	}: {
		node: QaTreeNode<QaMapFeature>;
		/** The project address, such as /org/KEY. */
		base: string;
		/** The paths of the groups that are closed. */
		collapsed: string[];
		ontoggle: (path: string) => void;
		/** Copies the retest command for a group path. */
		oncopy: (path: string) => void;
	} = $props();

	// -- CONSTANTS -- //

	const CARD = 'rounded-xl border border-line bg-surface shadow-[var(--elev-1)] overflow-hidden';
	const uid = $props.id();
	// The statuses that need a look come first, works last, and a status with none is left out
	const SHOWN: QaStatus[] = ['broken', 'needs_retest', 'could_not_test', 'not_tested', 'works'];

	// -- REACTIVE STATES -- //

	const open = $derived(!collapsed.includes(node.path));
	const counts = $derived(qaCounts(node.all.map((f) => qaStatusOf(f.status))));
	const total = $derived(node.all.length);
</script>

<!-- A GROUP: ITS HEADER, THEN ITS OWN FEATURES, THEN ITS SUB-GROUPS. A TOP GROUP IS A CARD. A SUB-GROUP IS INDENTED 16 PX PER LEVEL, TINTED AND SEPARATED BY A HAIRLINE, WITH NO CONNECTOR LINE -->
<section class={node.depth === 0 ? CARD : ''} data-testid="qa-area">
	<!-- THE INDENT IS A RUNTIME LEVEL, SO IT IS AN INLINE PADDING -->
	<div
		style="padding-left:{8 + node.depth * 16}px"
		class={cn(
			'flex flex-wrap items-center gap-x-3 gap-y-1 pr-3',
			node.depth > 0 ? 'min-h-11 border-t border-line bg-raised' : 'min-h-12',
			// A sub-group header draws its own hairline above, so a top group draws one under its header only above its own rows
			open && node.depth === 0 && node.own.length > 0 && 'border-b border-line'
		)}
	>
		<button
			type="button"
			data-qa-nav
			aria-expanded={open}
			aria-controls={open ? `${uid}-body` : undefined}
			onclick={() => ontoggle(node.path)}
			class="flex min-h-11 min-w-0 flex-1 basis-40 cursor-pointer items-center gap-1.5 rounded-lg px-1 text-left text-sm text-ink hover:text-muted focus-visible:outline-2 focus-visible:outline-accent"
		>
			<ChevronRight
				size={16}
				class={cn(
					'shrink-0 text-muted transition-transform duration-150 motion-reduce:transition-none',
					open && 'rotate-90'
				)}
				aria-hidden="true"
			/>
			{#if node.trail}<span class="truncate font-normal text-muted">{node.trail} /</span>{/if}
			<span class="shrink-0 font-semibold">{node.label}</span>
			<span class="shrink-0 text-xs font-normal text-muted tabular-nums"
				>{total} {qaPlural(total, 'feature')}</span
			>
		</button>
		<!-- HOW MANY FEATURES HAVE EACH STATUS, HIDDEN ON A PHONE WHERE THE HEALTH BAR SAYS IT -->
		<span class="flex items-center gap-3 text-xs text-muted tabular-nums max-sm:hidden">
			{#each SHOWN as s (s)}
				{#if counts[s] > 0}
					<span class="inline-flex items-center gap-1" title={QA_STATUS_LABEL[s]}>
						<QaStatusDot status={s} decorative />{counts[s]}
					</span>
				{/if}
			{/each}
		</span>
		<span class="w-24 shrink-0 max-sm:flex-1">
			<QaHealthBar
				{counts}
				label={`${node.path}: ${total} ${qaPlural(total, 'feature')}`}
				class="h-1.5 w-full"
			/>
		</span>
		<!-- ONE RETEST COPY FOR THE WHOLE GROUP, ICON ONLY -->
		<Tooltip text="Copy the retest command for this group">
			{#snippet children({ props })}
				<Button
					{...props}
					variant="subtle"
					size="sm"
					iconOnly
					aria-label={`Copy the retest command for ${node.path}`}
					onclick={() => oncopy(node.path)}
					data-testid="qa-group-retest"
				>
					<Copy size={16} />
				</Button>
			{/snippet}
		</Tooltip>
	</div>
	{#if open}
		<div id={`${uid}-body`}>
			{#if node.own.length > 0}
				<ul>
					{#each node.own as f (f.id)}
						<QaFeatureRow feature={f} href={`${base}/qa/${f.key}`} depth={node.depth} />
					{/each}
				</ul>
			{/if}
			{#each node.children as child (child.path)}
				<QaAreaGroup node={child} {base} {collapsed} {ontoggle} {oncopy} />
			{/each}
		</div>
	{/if}
</section>
