<!-- WHAT SHOWS WHILE THE EDITOR CODE LOADS: THE TOOLBAR AND THE BODY AT THEIR REAL HEIGHTS (40 / 44 PX TOOLBAR, 320 PX BODY, 32 BY 24 / 16 PX PADDING), SO NOTHING MOVES WHEN THE EDITOR ARRIVES -->
<div
	class="overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--elev-1)]"
	role="status"
	aria-busy="true"
	aria-label="Loading the editor"
	data-testid="note-editor-skeleton"
>
	<div
		class="flex items-center gap-1 border-b border-line bg-raised px-2 max-md:h-11 md:h-10"
		aria-hidden="true"
	>
		{#each Array.from({ length: 10 }, (_, i) => i) as i (i)}
			<div class="size-6 shrink-0 rounded-md bg-line motion-safe:animate-pulse"></div>
		{/each}
	</div>
	<div
		class="flex min-h-[368px] flex-col gap-2 px-8 py-6 max-sm:min-h-[352px] max-sm:p-4"
		aria-hidden="true"
	>
		<div class="h-4 w-full rounded-md bg-raised motion-safe:animate-pulse"></div>
		<div class="h-4 w-full rounded-md bg-raised motion-safe:animate-pulse"></div>
		<div class="h-4 w-2/3 rounded-md bg-raised motion-safe:animate-pulse"></div>
	</div>
</div>
