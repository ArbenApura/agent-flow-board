<script lang="ts">
	// -- DEP-TYPES -- //
	import type { Component, Snippet } from 'svelte';
	// -- TYPES -- //
	import type { FramePin, PinKey, PinMessage, PinPoint, ScreenKey } from '#lib/board/mockups.js';
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
	// -- MODULES -- //
	import { effectiveDevice, fitScale, showsSwitch } from '#lib/board/frames.js';
	import {
		SCREEN_LABEL,
		boxPlace,
		focusMessage,
		frameColour,
		isReadyMessage,
		parsePinClick,
		parsePinKey,
		parsePinMessage,
		parsePinMove,
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
		draft = null,
		picked = $bindable(),
		focus = null,
		ondevice,
		onpin,
		onmove,
		onpinclick,
		onkey,
		toolbar,
		composer,
		drawer
	}: {
		/** The 5 minute signed address of the mockup file. */
		src: string;
		/** The devices to offer. */
		screens: ScreenKey[];
		title: string;
		/** The pins to draw on the device on show, drawn by the mockup itself so they stay on the element when it scrolls. */
		pins?: FramePin[];
		pinMode?: boolean;
		/** The pin being placed, drawn by the mockup and dragged there. */
		draft?: { x: number; y: number } | null;
		/** The device the person picked. Until then the first device is shown. */
		picked?: ScreenKey;
		/** Asks the mockup to scroll a pin into view and pulse it. A new `seq` asks again for the same pin. */
		focus?: { id: string; seq: number } | null;
		/** Tells the page which device is really on show, so it can pick the pins of that device. */
		ondevice?: (device: ScreenKey) => void;
		onpin?: (pin: PinMessage) => void;
		onmove?: (point: PinPoint) => void;
		onpinclick?: (id: string) => void;
		onkey?: (key: PinKey) => void;
		/** Buttons on the right of the device switch. */
		toolbar?: Snippet;
		/** The comment box. It is drawn on the stage beside the pin being placed. */
		composer?: Snippet;
		/** The comments drawer. It sits on top of the stage, so the preview keeps its width. */
		drawer?: Snippet;
	} = $props();

	// -- CONSTANTS -- //

	const DEVICE_ICON: Record<
		ScreenKey,
		Component<{ size?: number; class?: string; 'aria-hidden'?: 'true' }>
	> = { wide: Monitor, laptop: Laptop, tablet: Tablet, phone: Smartphone };
	const BOX_WIDTH = 380;

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
	/** Counts the changes of the colour mode or palette, so the pins are sent in the colour on show. */
	let lookTick = $state(0);
	/** Where the comment box sits on the stage, in pixels. */
	let anchor = $state<{ left: number; top: number } | null>(null);
	let boxHeight = $state(200);
	/** The last click or drag point, so the box can be placed again when its height or the stage changes. */
	let lastPoint: PinPoint | null = null;

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

	const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

	/** Puts the comment box beside the pin: the frame's on-screen rectangle already carries the zoom or the transform. */
	function place(point: PinPoint) {
		lastPoint = point;
		if (!frame || !stage) return;
		const f = frame.getBoundingClientRect();
		const s = stage.getBoundingClientRect();
		anchor = boxPlace(
			point,
			{ left: f.left - s.left, top: f.top - s.top, width: f.width, height: f.height },
			{ width: s.width, height: s.height },
			{ width: BOX_WIDTH, height: boxHeight }
		);
	}

	function onMessage(e: MessageEvent) {
		const win = frame?.contentWindow;
		if (isReadyMessage(e.data, e.source, win)) {
			readyCount += 1;
			return;
		}
		const pin = parsePinMessage(e.data, e.source, win);
		if (pin) {
			place(pin);
			onpin?.(pin);
			return;
		}
		const move = parsePinMove(e.data, e.source, win);
		if (move) {
			place(move);
			onmove?.(move);
			return;
		}
		const id = parsePinClick(e.data, e.source, win);
		if (id) {
			onpinclick?.(id);
			return;
		}
		const key = parsePinKey(e.data, e.source, win);
		if (key) onkey?.(key);
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

	// Pins, the pin being placed and the pin mode go to the frame on every ready message and on every change, so a frame that loads
	// again is never left without them. The frame gets places and numbers only, never the text of a comment
	$effect(() => {
		if (readyCount === 0) return;
		void lookTick;
		const css = getComputedStyle(document.documentElement);
		const look = {
			draft,
			accent: frameColour(css.getPropertyValue('--accent')),
			ink: frameColour(css.getPropertyValue('--accent-ink')),
			reduced: reducedMotion()
		};
		for (const m of pinMessages(pinMode, pins, look)) send(m);
	});

	// A pin asked to be shown scrolls into view in the frame and pulses
	$effect(() => {
		const f = focus;
		if (!f || readyCount === 0) return;
		untrack(() => send(focusMessage(f.id, reducedMotion())));
	});

	// The comment box has no place while there is no pin being placed
	$effect(() => {
		if (!draft) {
			anchor = null;
			lastPoint = null;
		}
	});

	// The box is placed again when its own height or the size of the stage changes, so it never ends up clipped or off its pin
	$effect(() => {
		void boxHeight;
		void available;
		void scale;
		const point = lastPoint;
		if (draft && point) untrack(() => place(point));
	});

	// The page learns which device is on show
	$effect(() => {
		ondevice?.(device);
	});

	// A change of the colour mode or of the organisation palette redraws the pins in the accent on show
	$effect(() => {
		const watch = new MutationObserver(() => (lookTick += 1));
		watch.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-mode', 'style']
		});
		return () => watch.disconnect();
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
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		{#if showsSwitch(screens)}
			<div
				bind:this={switchRow}
				class="max-w-full [scrollbar-width:none]! overflow-x-auto overflow-y-hidden overscroll-x-contain [&::-webkit-scrollbar]:hidden"
			>
				<SegmentedControl
					label="Device"
					value={device}
					{options}
					onchange={(v) => (picked = v as ScreenKey)}
				/>
			</div>
		{/if}
		{#if toolbar}
			<div class="ml-auto flex flex-wrap items-center gap-2">{@render toolbar()}</div>
		{/if}
	</div>
	<div
		bind:this={stage}
		class="relative isolate min-h-60 overflow-hidden rounded-lg border border-line bg-raised p-6 max-sm:p-3"
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
			<!-- INSIDE THE STAGE PADDING AT THE BOTTOM, SO SHOWING AND HIDING IT NEVER MOVES ANYTHING -->
			<span
				class="pointer-events-none absolute bottom-0.5 left-1/2 z-10 -translate-x-1/2 rounded-md bg-accent-soft px-2 text-badge leading-5 font-medium whitespace-nowrap text-accent-text max-sm:hidden"
				data-testid="pin-hint">Click the mockup to place a comment. Esc to stop.</span
			>
		{/if}
		{#if draft && anchor && composer}
			<!-- THE COMMENT BOX SITS BESIDE THE PIN. ITS PLACE IS A RUNTIME COORDINATE ON THE STAGE -->
			<div
				bind:clientHeight={boxHeight}
				class="absolute z-40 w-[380px] max-w-[calc(100%-16px)]"
				style:left="{anchor.left}px"
				style:top="{anchor.top}px"
				data-testid="pin-box"
			>
				{@render composer()}
			</div>
		{/if}
		{#if drawer}{@render drawer()}{/if}
	</div>
</div>
