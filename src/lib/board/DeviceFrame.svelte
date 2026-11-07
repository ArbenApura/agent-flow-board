<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Snippet } from 'svelte';
	// -- TYPES -- //
	import type { ScreenKey } from '#lib/board/mockups.js';
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
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

	// -- STATES -- //

	/** True for a moment after the device changes, so the frame glides to its new size. A plain resize of the window never animates. */
	let animate = $state(false);
	let seen = untrack(() => screen);
	let timer: ReturnType<typeof setTimeout> | undefined;

	// -- REACTIVE STATES -- //

	const size = $derived(frameSize(screen));
	const browser = $derived(size.kind === 'browser');
	const tablet = $derived(size.kind === 'tablet');
	const phone = $derived(size.kind === 'phone');

	// -- REACTIVE STATEMENTS -- //

	// Runs before the page is updated, so the transition is in place in the same update that changes the size
	$effect.pre(() => {
		const s = screen;
		untrack(() => {
			if (s === seen) return;
			seen = s;
			animate = true;
			clearTimeout(timer);
			timer = setTimeout(() => (animate = false), 400);
		});
	});

	$effect(() => () => clearTimeout(timer));
</script>

<!-- A DEVICE AROUND ONE SLOT. ONLY CSS CHANGES BETWEEN DEVICES, SO THE FRAME INSIDE THE SLOT IS NEVER REMOUNTED. THE BOARD DRAWS IT, A MOCKUP FILE NEVER DOES, AND IT HAS NO CAMERA, NOTCH OR SPEAKER. THE BEZEL IS INK MIXED INTO THE SURFACE, 80 PERCENT IN LIGHT MODE AND 18 PERCENT IN DARK MODE, WITH A 1 PX LINE EDGE -->
<!-- CHROMIUM: THE FRAME SIZES ITSELF (ZOOM LAYS THE PAGE OUT AT THE SMALLER SIZE), SO EVERY PART GLIDES TOGETHER AND THE MOCKUP RE-FLOWS LIVE WHILE IT DOES. THE OTHERS: A BOX OF THE SCALED SIZE THAT CLIPS, SO THE PAGE NEVER SCROLLS SIDEWAYS. THE SIZES AND THE SCALE ARE RUNTIME VALUES -->
<div
	class={cn(
		'mx-auto shrink-0 overflow-hidden',
		zoomable && 'w-fit',
		!zoomable &&
			animate &&
			'transition-[width,height] duration-300 ease-out motion-reduce:transition-none'
	)}
	data-testid="device-frame"
	data-device={screen}
	style:width={zoomable ? undefined : `${Math.ceil(size.width * scale)}px`}
	style:height={zoomable ? undefined : `${Math.ceil(size.height * scale)}px`}
>
	<!-- CHROMIUM USES ZOOM, WHICH LAYS THE PAGE OUT AT THE SMALLER SIZE, SO TEXT STAYS SHARP. A TRANSFORM ON A SANDBOXED FRAME IS SCALED AS A PICTURE AND BLURS IT -->
	<div
		class={cn(
			'origin-top-left',
			zoomable &&
				animate &&
				'transition-[width,height,zoom] duration-300 ease-out motion-reduce:transition-none'
		)}
		style:width="{size.width}px"
		style:height="{size.height}px"
		style:zoom={zoomable ? scale : undefined}
		style:transform={zoomable ? undefined : `scale(${scale})`}
	>
		<div
			class={cn(
				'relative flex size-full flex-col border border-line transition-[padding,border-radius,background-color] duration-300 ease-out motion-reduce:transition-none',
				browser
					? 'rounded-xl bg-surface'
					: 'bg-[color-mix(in_srgb,var(--ink)_80%,var(--surface))] in-data-[mode=dark]:bg-[color-mix(in_srgb,var(--ink)_18%,var(--surface))]',
				tablet && 'rounded-[24px] p-[14px]',
				phone && 'rounded-[36px] p-[12px]'
			)}
		>
			<!-- THE BROWSER BAR: THREE DOTS AND A PILL WITH THE MOCKUP TITLE. IT STAYS IN PLACE AND SHRINKS TO NOTHING ON A TABLET OR A PHONE, SO IT NEVER POPS -->
			<div
				class={cn(
					'flex shrink-0 items-center gap-2 overflow-hidden border-line bg-surface transition-[height] duration-300 ease-out motion-reduce:transition-none',
					browser ? 'h-10 rounded-t-xl border-b px-3.5' : 'h-0 px-3.5'
				)}
				aria-hidden="true"
			>
				<span class="size-2.5 shrink-0 rounded-full bg-line"></span>
				<span class="size-2.5 shrink-0 rounded-full bg-line"></span>
				<span class="size-2.5 shrink-0 rounded-full bg-line"></span>
				<span
					class="mx-auto h-6 max-w-[60%] min-w-0 flex-1 truncate rounded-full bg-raised px-3 text-center text-xs leading-6 text-muted"
					>{title}</span
				>
				<span class="w-[46px] shrink-0"></span>
			</div>
			<div
				class={cn(
					'relative shrink-0 overflow-hidden bg-surface transition-[width,height,border-radius] duration-300 ease-out motion-reduce:transition-none',
					browser && 'rounded-b-[11px]',
					tablet && 'rounded-[10px]',
					phone && 'rounded-[24px]'
				)}
				style:width="{size.screenWidth}px"
				style:height="{size.screenHeight}px"
			>
				{@render children()}
			</div>
			{#if phone}
				<span
					class="pointer-events-none absolute bottom-[4px] left-1/2 h-1 w-[120px] -translate-x-1/2 rounded-full bg-surface/50"
					aria-hidden="true"
				></span>
			{/if}
		</div>
	</div>
</div>
