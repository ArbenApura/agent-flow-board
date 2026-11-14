<script lang="ts" generics="T">
	// IMPORTED DEP-TYPES
	import type { Snippet } from 'svelte';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		items,
		rowHeight,
		row,
		keyOf,
		overscan = 6,
		label,
		total,
		placeholder,
		onreach,
		class: extra
	}: {
		items: T[];
		/** The full length when only a first part is loaded. Rows past `items` draw the placeholder. */
		total?: number;
		placeholder?: Snippet<[number]>;
		/** Called with the index just past the last row in view, so the parent can load the next page. */
		onreach?: (index: number) => void;
		/** Fixed row height in px, so the window can be calculated without measuring. */
		rowHeight: number;
		row: Snippet<[T, number]>;
		/** A key that is unique by definition (an id). */
		keyOf: (item: T) => string;
		overscan?: number;
		label: string;
		class?: string;
	} = $props();

	// -- STATES -- //

	let scrollTop = $state(0);
	let viewport = $state(480);

	// -- REACTIVE STATES -- //

	const first = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
	const length = $derived(total ?? items.length);
	const last = $derived(Math.min(length, Math.ceil((scrollTop + viewport) / rowHeight) + overscan));
	const visible = $derived(items.slice(first, last));
	const pending = $derived(
		placeholder
			? Array.from(
					{ length: Math.max(0, last - Math.max(first, items.length)) },
					(_, k) => Math.max(first, items.length) + k
				)
			: []
	);

	// -- EFFECTS -- //

	$effect(() => {
		onreach?.(last);
	});
</script>

<!-- ONLY THE ROWS IN VIEW (PLUS A FEW) ARE IN THE DOM, SO 5,000 ITEMS STAY FAST -->
<div
	role="list"
	aria-label={label}
	class={cn('relative overflow-y-auto overscroll-contain', extra)}
	bind:clientHeight={viewport}
	onscroll={(e) => (scrollTop = e.currentTarget.scrollTop)}
>
	<!-- DYNAMIC RUNTIME HEIGHT OF THE FULL LIST -->
	<div class="relative w-full" style="height:{length * rowHeight}px;">
		{#each visible as item, i (keyOf(item))}
			<!-- DYNAMIC RUNTIME ROW POSITION -->
			<div
				role="listitem"
				aria-posinset={first + i + 1}
				aria-setsize={length}
				class="absolute right-0 left-0"
				style="top:{(first + i) * rowHeight}px;height:{rowHeight}px;"
			>
				{@render row(item, first + i)}
			</div>
		{/each}
		{#each pending as index (index)}
			<!-- DYNAMIC RUNTIME ROW POSITION -->
			<div
				role="listitem"
				aria-hidden="true"
				class="absolute right-0 left-0"
				style="top:{index * rowHeight}px;height:{rowHeight}px;"
			>
				{@render placeholder!(index)}
			</div>
		{/each}
	</div>
</div>
