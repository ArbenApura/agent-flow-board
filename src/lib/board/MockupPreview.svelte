<script lang="ts">
	// -- TYPES -- //
	import type { PinMessage, PinRow, ScreenKey } from '#lib/board/mockups.js';
	// -- DEP-MODULES -- //
	import { untrack } from 'svelte';
	// -- MODULES -- //
	import {
		SCREEN_LABEL,
		SCREEN_WIDTH,
		isReadyMessage,
		parsePinMessage,
		scaleFor
	} from '#lib/board/mockups.js';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';

	// -- REQUIRED PROPS -- //

	let {
		src,
		screens,
		title,
		pins = [],
		pinMode = false,
		onpin,
		screen = $bindable('laptop')
	}: {
		/** The 5 minute signed address of the mockup file. */
		src: string;
		screens: ScreenKey[];
		title: string;
		/** The pins of the version on show, drawn by the mockup itself so they stay on the element when it scrolls. */
		pins?: PinRow[];
		pinMode?: boolean;
		onpin?: (pin: PinMessage) => void;
		screen?: ScreenKey;
	} = $props();

	// -- CONSTANTS -- //

	/** The stage is this tall on a wide screen and a little shorter on a phone. The mockup scrolls inside it. */
	const STAGE_HEIGHT = 640;
	const STAGE_HEIGHT_PHONE = 480;

	// -- STATES -- //

	/** The address the frame shows. It changes only when another file is shown, never when the same file is signed again. */
	let shownSrc = $state(untrack(() => src));
	let shownKey = untrack(() => keyOf(src));
	let stage = $state<HTMLElement>();
	let frame = $state<HTMLIFrameElement>();
	let available = $state(0);
	let ready = $state(false);

	// -- REACTIVE STATES -- //

	const width = $derived(SCREEN_WIDTH[screen]);
	const scale = $derived(scaleFor(available, width));
	const narrow = $derived(available > 0 && available < 560);
	const stageHeight = $derived(narrow ? STAGE_HEIGHT_PHONE : STAGE_HEIGHT);
	// A phone sized mockup sits in the middle of the stage, in a plain device frame without browser chrome
	const phone = $derived(screen === 'phone');
	const options = $derived(screens.map((s) => ({ value: s, label: SCREEN_LABEL[s] })));

	// -- FUNCTIONS -- //

	/** The part of a signed address before its expiry and signature, which names the file. */
	function keyOf(address: string) {
		return address.split('?')[0];
	}

	function send(message: Record<string, unknown>) {
		// The mockup runs sandboxed with no origin of its own, so the only possible target is any
		frame?.contentWindow?.postMessage(message, '*');
	}

	function onMessage(e: MessageEvent) {
		const win = frame?.contentWindow;
		if (isReadyMessage(e.data, e.source, win)) {
			ready = true;
			return;
		}
		const pin = parsePinMessage(e.data, e.source, win);
		if (pin) onpin?.(pin);
	}

	// -- REACTIVE STATEMENTS -- //

	// Every load of the page signs the address again, so a new string for the same file is not a new file: reloading the frame would
	// throw away its scroll and state each time a pin is posted or a teammate changes something
	$effect(() => {
		const key = keyOf(src);
		if (key === shownKey) return;
		shownKey = key;
		shownSrc = src;
	});

	// A new file means the frame must announce itself again before it is sent anything
	$effect(() => {
		void shownSrc;
		ready = false;
	});

	$effect(() => {
		if (!ready) return;
		send({ type: 'afb-pin-mode', on: pinMode });
		send({ type: 'afb-pins', pins: pins.map((p) => ({ x: p.x, y: p.y })) });
	});

	// The stage reports its own width, so the mockup is shrunk to fit it and never scrolls the page sideways
	$effect(() => {
		const el = stage;
		if (!el) return;
		const watch = new ResizeObserver(([entry]) => (available = entry.contentRect.width));
		watch.observe(el);
		return () => watch.disconnect();
	});
</script>

<svelte:window onmessage={onMessage} />

<!-- THE PREVIEW: A WIDTH SWITCH AND THE MOCKUP IN A SANDBOXED FRAME. THE FRAME IS CLIPPED TO ITS STAGE AND SCROLLS INSIDE IT -->
<div class="flex flex-col gap-3" data-testid="mockup-preview">
	{#if screens.length > 1}
		<div
			class="[scrollbar-width:none]! overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden"
		>
			<SegmentedControl
				label="Screen width"
				value={screen}
				{options}
				onchange={(v) => (screen = v as ScreenKey)}
			/>
		</div>
	{/if}
	<div
		bind:this={stage}
		class="relative overflow-hidden rounded-lg border border-line bg-raised"
		class:flex={phone}
		class:justify-center={phone}
		style:height="{stageHeight}px"
	>
		<!-- THE FRAME IS DRAWN AT THE REAL SCREEN WIDTH AND SHRUNK WITH A TRANSFORM. ITS SIZE AND SCALE ARE RUNTIME VALUES -->
		<div
			class="origin-top-left"
			style:width="{width}px"
			style:height="{stageHeight / scale}px"
			style:transform="scale({scale})"
		>
			<iframe
				bind:this={frame}
				src={shownSrc}
				{title}
				sandbox="allow-scripts"
				referrerpolicy="no-referrer"
				class="size-full border-0 bg-surface"
				data-testid="mockup-frame"
			></iframe>
		</div>
		{#if pinMode}
			<span
				class="pointer-events-none absolute top-2 left-2 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-ink"
				>Click the mockup to place a pin</span
			>
		{/if}
	</div>
</div>
