<script lang="ts">
	// -- MODULES -- //
	import { projectPictureUrl } from '#lib/board/pictures.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		id,
		projectKey,
		logoV,
		size = 24,
		class: extra
	}: {
		id: string;
		projectKey: string;
		/** The version of the project's logo, or null when it has none. The picture is read from /pictures/project. */
		logoV?: number | null;
		size?: 24 | 40;
		class?: string;
	} = $props();

	// -- CONSTANTS -- //

	// Whole class names, Tailwind builds only those. The same two boxes as OrgTile
	const DIMS = {
		24: 'size-6 min-h-6 max-h-6 min-w-6 max-w-6 rounded-md text-xs',
		40: 'size-10 min-h-10 max-h-10 min-w-10 max-w-10 rounded-lg text-sm'
	} as const;

	// -- STATES -- //

	/** The address that failed to load, so a broken logo falls back to the key instead of an empty box. */
	let failed = $state<string | null>(null);

	// -- REACTIVE STATES -- //

	const logo = $derived(projectPictureUrl(id, logoV));
	const shown = $derived(logo && logo !== failed ? logo : null);
</script>

<!-- THE MARK OF A PROJECT. ITS LOGO WHEN IT HAS ONE, OTHERWISE THE FIRST TWO LETTERS OF ITS KEY -->
{#if shown}
	<img
		src={shown}
		alt=""
		onerror={() => (failed = shown)}
		class={cn('shrink-0 object-contain', DIMS[size], extra)}
	/>
{:else}
	<span
		class={cn(
			'flex shrink-0 items-center justify-center bg-raised font-mono font-medium text-muted uppercase',
			DIMS[size],
			extra
		)}
		aria-hidden="true"
	>
		{projectKey.slice(0, 2)}
	</span>
{/if}
