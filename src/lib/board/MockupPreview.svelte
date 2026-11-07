<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Component } from 'svelte';
	// -- TYPES -- //
	import type { PinMessage, PinRow, ScreenKey } from '#lib/board/mockups.js';
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
	// -- MODULES -- //
	import { effectiveDevice, fitScale, showsSwitch } from '#lib/board/frames.js';
	import {
		SCREEN_LABEL,
		isReadyMessage,
		parsePinMessage,
		pinMessages
	} from '#lib/board/mockups.js';
	import { fileKey } from '#lib/board/thumbLoad.js';
	import DeviceFrame from '#lib/board/DeviceFrame.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	// -- DEP-COMPONENTS -- //
	import Laptop from '@lucide/svelte/icons/laptop';
	import Monitor from '@lucide/svelte/icons/monitor';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import Tablet from '@lucide/svelte/icons/tablet';

	// -- REQUIRED PROPS -- //

	let {
		src,
		screens,
		title,
		pins = [],
		pinMode = false,
		onpin
	}: {
		/** The 5 minute signed address of the mockup file. */
		src: string;
		/** The devices the project offers. */
		screens: ScreenKey[];
		title: string;
		/** The pins of the version on show, drawn by the mockup itself so they stay on the element when it scrolls. */
		pins?: PinRow[];
		pinMode?: boolean;
		onpin?: (pin: PinMessage) => void;
	} = $props();

	// -- CONSTANTS -- //

	const DEVICE_ICON: Record<
		ScreenKey,
		Component<{ size?: number; class?: string; 'aria-hidden'?: 'true' }>
	> = { wide: Monitor, laptop: Laptop, tablet: Tablet, phone: Smartphone };

	// -- STATES -- //

	/** The address the frame shows. It changes only when another file is shown, never when the same file is signed again. */
	let shownSrc = $state(untrack(() => src));
	let shownKey = untrack(() => fileKey(src));
	let stage = $state<HTMLElement>();
	let switchRow = $state<HTMLElement>();
	let frame = $state<HTMLIFrameElement>();
	let available = $state(0);
	/** Counts the ready messages, so every one of them sends the pins again. */
	let readyCount = $state(0);
	let zoomable = $state(false);
	/** The device the person picked. Until then, and when the project stops offering it, the first device is shown. */
	let picked = $state<ScreenKey>();

	// -- REACTIVE STATES -- //

	const device = $derived(effectiveDevice(picked, screens, available));
	const scale = $derived(fitScale(available, device));
	const options = $derived(
		screens.map((s) => ({ value: s, label: SCREEN_LABEL[s], icon: DEVICE_ICON[s] }))
	);

	// -- FUNCTIONS -- //

	function send(message: Record<string, unknown>) {
		// The mockup runs sandboxed with no origin of its own, so the only possible target is any
		frame?.contentWindow?.postMessage(message, '*');
	}

	function onMessage(e: MessageEvent) {
		const win = frame?.contentWindow;
		if (isReadyMessage(e.data, e.source, win)) {
			readyCount += 1;
			return;
		}
		const pin = parsePinMessage(e.data, e.source, win);
		if (pin) onpin?.(pin);
	}

	// -- REACTIVE STATEMENTS -- //

	// Every load of the page signs the address again, so a new string for the same file is not a new file: reloading the frame would
	// throw away its scroll and state each time a pin is posted or a teammate changes something
	$effect(() => {
		const key = fileKey(src);
		// While the stage has no width the frame is not mounted, so the freshest address is kept for when it comes back: an address
		// kept from the first load would be expired by then
		if (key === shownKey && available > 0) return;
		shownKey = key;
		shownSrc = src;
	});

	// A new file, or a new frame element, must announce itself again before it is sent anything
	$effect(() => {
		void shownSrc;
		void frame;
		readyCount = 0;
	});

	// Pins and pin mode go to the frame on every ready message, so a frame that loads again is never left without them
	$effect(() => {
		if (readyCount === 0) return;
		for (const m of pinMessages(pinMode, pins)) send(m);
	});

	// The stage reports its own width, so the frame is shrunk to fit it and never scrolls the page sideways
	$effect(() => {
		const el = stage;
		if (!el) return;
		// Only Chromium scales a frame's content with zoom, so the others keep the transform
		zoomable = 'userAgentData' in navigator;
		const watch = new ResizeObserver(([entry]) => (available = entry.contentRect.width));
		watch.observe(el);
		return () => watch.disconnect();
	});

	// The chosen device slides to the centre of the switch row, which scrolls sideways on a phone
	$effect(() => {
		void device;
		const row = switchRow;
		const active = row?.querySelector<HTMLElement>('[aria-checked="true"]');
		if (!row || !active) return;
		const left =
			active.getBoundingClientRect().left -
			row.getBoundingClientRect().left +
			row.scrollLeft -
			(row.clientWidth - active.offsetWidth) / 2;
		row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
	});
</script>

<svelte:window onmessage={onMessage} />

<!-- THE PREVIEW: A DEVICE SWITCH AND THE MOCKUP IN A SANDBOXED FRAME, DRAWN INSIDE A DEVICE. THE WHOLE DEVICE SHOWS, AND THE MOCKUP SCROLLS INSIDE ITS SCREEN ONLY -->
<div class="flex flex-col gap-3" data-testid="mockup-preview">
	{#if showsSwitch(screens)}
		<div
			bind:this={switchRow}
			class="[scrollbar-width:none]! overflow-x-auto overflow-y-hidden overscroll-x-contain [&::-webkit-scrollbar]:hidden"
		>
			<SegmentedControl
				label="Device"
				value={device}
				{options}
				onchange={(v) => (picked = v as ScreenKey)}
			/>
		</div>
	{/if}
	<div
		bind:this={stage}
		class="relative min-h-60 overflow-hidden rounded-lg border border-line bg-raised p-6 max-sm:p-3"
	>
		{#if available > 0}
			<DeviceFrame screen={device} {title} {scale} {zoomable}>
				<iframe
					bind:this={frame}
					src={shownSrc}
					{title}
					sandbox="allow-scripts"
					referrerpolicy="no-referrer"
					class="size-full border-0 bg-surface"
					data-testid="mockup-frame"
				></iframe>
			</DeviceFrame>
		{/if}
		{#if pinMode}
			<span
				class="pointer-events-none absolute top-2 left-2 z-10 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-ink"
				>Click the mockup to place a pin</span
			>
		{/if}
	</div>
</div>
