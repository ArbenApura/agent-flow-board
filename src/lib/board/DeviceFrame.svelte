<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- TYPES -- //
	import type { ScreenKey } from '#lib/board/mockups.js';
	// -- MODULES -- //
	import { frameSize } from '#lib/board/frames.js';
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		screen,
		title,
		scale,
		zoomable,
		children
	}: {
		screen: ScreenKey;
		/** The page title shown in the browser bar, as plain text. There is no real address. */
		title: string;
		/** How much the whole frame is shrunk to fit its stage, never above 1. */
		scale: number;
		/** Chromium lays the frame out at the smaller size with zoom; the others scale it with a transform. */
		zoomable: boolean;
		/** The screen. The caller mounts one frame element here, so a device switch never remounts it. */
		children: Snippet;
	} = $props();

	// -- REACTIVE STATES -- //

	const size = $derived(frameSize(screen));
	const browser = $derived(size.kind === 'browser');
	const tablet = $derived(size.kind === 'tablet');
	const phone = $derived(size.kind === 'phone');
</script>

<!-- A DEVICE AROUND ONE SLOT. ONLY CSS CHANGES BETWEEN DEVICES, SO THE FRAME INSIDE THE SLOT IS NEVER REMOUNTED. THE BOARD DRAWS IT, A MOCKUP FILE NEVER DOES. THE BEZEL IS INK MIXED INTO THE SURFACE, 80 PERCENT IN LIGHT MODE AND 18 PERCENT IN DARK MODE, WITH A 1 PX LINE EDGE -->
<!-- THE OUTER BOX HAS THE SCALED SIZE AND CLIPS, SO THE PAGE NEVER SCROLLS SIDEWAYS. THE SIZES AND THE SCALE ARE RUNTIME VALUES -->
<div
	class="mx-auto shrink-0 overflow-hidden"
	data-testid="device-frame"
	data-device={screen}
	style:width="{Math.ceil(size.width * scale)}px"
	style:height="{Math.ceil(size.height * scale)}px"
>
	<!-- CHROMIUM USES ZOOM, WHICH LAYS THE PAGE OUT AT THE SMALLER SIZE, SO TEXT STAYS SHARP. A TRANSFORM ON A SANDBOXED FRAME IS SCALED AS A PICTURE AND BLURS IT -->
	<div
		class="origin-top-left"
		style:width="{size.width}px"
		style:height="{size.height}px"
		style:zoom={zoomable ? scale : undefined}
		style:transform={zoomable ? undefined : `scale(${scale})`}
	>
		<div
			class={cn(
				'relative flex size-full flex-col border border-line',
				browser
					? 'overflow-hidden rounded-xl bg-surface'
					: 'bg-[color-mix(in_srgb,var(--ink)_80%,var(--surface))] in-data-[mode=dark]:bg-[color-mix(in_srgb,var(--ink)_18%,var(--surface))]',
				tablet && 'rounded-[24px] p-[14px]',
				phone && 'rounded-[36px] p-[12px]'
			)}
		>
			{#if browser}
				<!-- THE BROWSER BAR: THREE DOTS AND A PILL WITH THE MOCKUP TITLE -->
				<div
					class="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-surface px-3.5"
					aria-hidden="true"
				>
					<span class="size-2.5 rounded-full bg-line"></span>
					<span class="size-2.5 rounded-full bg-line"></span>
					<span class="size-2.5 rounded-full bg-line"></span>
					<span
						class="mx-auto h-6 max-w-[60%] min-w-0 flex-1 truncate rounded-full bg-raised px-3 text-center text-xs leading-6 text-muted"
						>{title}</span
					>
					<span class="w-[46px]"></span>
				</div>
			{/if}
			<div
				class={cn(
					'relative shrink-0 overflow-hidden bg-surface',
					tablet && 'rounded-[10px]',
					phone && 'rounded-[24px]'
				)}
				style:width="{size.screenWidth}px"
				style:height="{size.screenHeight}px"
			>
				{@render children()}
			</div>
			{#if tablet}
				<span
					class="pointer-events-none absolute top-[4px] left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-surface/40"
					aria-hidden="true"
				></span>
			{/if}
			{#if phone}
				<span
					class="pointer-events-none absolute top-[20px] left-1/2 h-5 w-[72px] -translate-x-1/2 rounded-full bg-[color-mix(in_srgb,var(--ink)_80%,var(--surface))] in-data-[mode=dark]:bg-[color-mix(in_srgb,var(--ink)_18%,var(--surface))]"
					aria-hidden="true"
				></span>
				<span
					class="pointer-events-none absolute bottom-[4px] left-1/2 h-1 w-[120px] -translate-x-1/2 rounded-full bg-surface/50"
					aria-hidden="true"
				></span>
			{/if}
		</div>
	</div>
</div>
