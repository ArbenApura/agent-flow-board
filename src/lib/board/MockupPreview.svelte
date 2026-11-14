<script lang="ts">
	// IMPORTED DEP-TYPES
	import type { Component, Snippet } from 'svelte';
	// IMPORTED TYPES
	import type {
		FramePin,
		FrameConfig,
		PinKey,
		PinMessage,
		PinPoint,
		ScreenKey
	} from '#lib/board/mockups.js';
	// IMPORTED ENVS
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	// IMPORTED DEP-MODULES
	import { untrack } from 'svelte';
	// IMPORTED MODULES
	import { effectiveDevice, fitScale, showsSwitch } from '#lib/board/frames.js';
	import {
		SCREEN_LABEL,
		SCREEN_OPTION,
		boxPlace,
		focusMessage,
		frameColour,
		isReadyMessage,
		parseConfigMessage,
		parsePinClick,
		parsePinKey,
		parsePinMessage,
		parsePinMove,
		parseStepMessage,
		parseUnresponsiveMessage,
		pinMessages,
		setMessage,
		validChoice,
		visibleOptions
	} from '#lib/board/mockups.js';
	import { fileKey } from '#lib/board/thumbLoad.js';
	import DeviceFrame from '#lib/board/DeviceFrame.svelte';
	import MockupScreenStrip from '#lib/board/MockupScreenStrip.svelte';
	import Select from '#lib/ui/Select.svelte';
	import SegmentedControl from '#lib/ui/SegmentedControl.svelte';
	import { cn } from '#lib/ui/cn.js';
	// IMPORTED DEP-COMPONENTS
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
		sticky = false,
		flush = false,
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
		/** Keeps the toolbar under the top bar while the page scrolls. The card around it must not clip. */
		sticky?: boolean;
		/** On a phone the preview runs to the edges of its card, cancelling the card's 14 px padding. The parent must be a padded card body. */
		flush?: boolean;
		/** Tells the page which device is really on show, so it can pick the pins of that device. */
		ondevice?: (device: ScreenKey) => void;
		onpin?: (pin: PinMessage) => void;
		onmove?: (point: PinPoint) => void;
		onpinclick?: (id: string) => void;
		onkey?: (key: PinKey) => void;
		/** Buttons on the right of the toolbar. */
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
	/** What the mockup on show declared (its screens and options), null until it has said so or when it declares nothing. */
	let config = $state<FrameConfig | null>(null);
	/** The value on show for each option and for the screen list. */
	let choices = $state<Record<string, string>>({});
	/** The last click or drag point, so the box can be placed again when its height or the stage changes. */
	let lastPoint: PinPoint | null = null;
	/** The choice the person made last. Only the answer to this one is shown, never the answer to a choice made while loading. */
	let pendingKey = $state<string | null>(null);
	/** Set when the page said a choice changed nothing, or that its own hook threw. Cleared on the next choice. */
	let quiet = $state<{ key: string; reason: 'none' | 'error' } | null>(null);

	// -- REACTIVE STATES -- //

	const device = $derived(effectiveDevice(picked, screens, available));
	const scale = $derived(fitScale(available, device));
	const options = $derived(
		screens.map((s) => ({ value: s, label: SCREEN_LABEL[s], icon: DEVICE_ICON[s] }))
	);
	// Only the options that apply to the screen on show are drawn. The others keep their value in `choices`
	const shownOptions = $derived(config ? visibleOptions(config, choices[SCREEN_OPTION]) : []);
	// What the quiet hint says: the name of the control the person used, and whether nothing changed or the page's own hook threw
	const quietText = $derived.by(() => {
		if (!quiet) return '';
		const name =
			quiet.key === SCREEN_OPTION
				? 'the screen'
				: (config?.options.find((o) => o.key === quiet?.key)?.label ?? quiet.key);
		return quiet.reason === 'error'
			? `The mockup's own switch code failed for ${name}. The page may not show that choice.`
			: `Nothing on the page changed when you switched ${name}. This mockup may not react to it.`;
	});

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

	/** What the address and the browser remember for this mockup: the address wins. Values are checked against what the mockup declared before use. */
	function remembered(): Record<string, string> {
		const out: Record<string, string> = {};
		try {
			const raw = localStorage.getItem(`afb:mockup-choices:${shownKey}`);
			const saved: unknown = raw ? JSON.parse(raw) : null;
			if (saved && typeof saved === 'object')
				for (const [k, v] of Object.entries(saved)) if (typeof v === 'string') out[k] = v;
		} catch {
			// Browser storage can be blocked: the choices then start from the mockup's own values
		}
		for (const [k, v] of page.url.searchParams) if (k.startsWith('o-')) out[k.slice(2)] = v;
		return out;
	}

	function remember() {
		try {
			localStorage.setItem(`afb:mockup-choices:${shownKey}`, JSON.stringify(choices));
		} catch {
			// Not being able to remember is not an error
		}
		try {
			const url = new URL(page.url.href);
			for (const k of [...url.searchParams.keys()])
				if (k.startsWith('o-')) url.searchParams.delete(k);
			for (const [k, v] of Object.entries(choices)) url.searchParams.set(`o-${k}`, v);
			replaceState(url, page.state);
		} catch {
			// The router may not be ready yet: the choice still shows, it is only not in the address
		}
	}

	/** A choice from the toolbar, the strip or a key: sent to the frame, which checks it against what the page declared. */
	function choose(key: string, value: string) {
		if (!config || validChoice(config, key, value) === null) return;
		pendingKey = key;
		quiet = null;
		choices = { ...choices, [key]: value };
		send(setMessage(key, value));
		remember();
	}

	function stepScreen(dir: 'prev' | 'next') {
		const list = config?.screens ?? [];
		if (list.length < 2) return;
		const at = list.findIndex((s) => s.value === choices[SCREEN_OPTION]);
		const to = list[Math.min(list.length - 1, Math.max(0, at + (dir === 'next' ? 1 : -1)))];
		choose(SCREEN_OPTION, to.value);
	}

	/** The page said what it offers: show it, and put back what the address or the browser remembered. */
	function applyConfig(got: { config: FrameConfig; current: Record<string, string> }) {
		const saved = remembered();
		const next = { ...got.current };
		for (const key of Object.keys(next)) {
			const v = validChoice(got.config, key, saved[key]);
			if (v && v !== next[key]) {
				next[key] = v;
				send(setMessage(key, v));
			}
		}
		config = got.config;
		choices = next;
	}

	function onKeydown(e: KeyboardEvent) {
		if ((e.key !== '[' && e.key !== ']') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
		if (document.querySelector('[aria-modal="true"]')) return;
		stepScreen(e.key === '[' ? 'prev' : 'next');
	}

	function onMessage(e: MessageEvent) {
		const win = frame?.contentWindow;
		if (isReadyMessage(e.data, e.source, win)) {
			readyCount += 1;
			return;
		}
		const offered = parseConfigMessage(e.data, e.source, win);
		if (offered) {
			applyConfig(offered);
			return;
		}
		const dir = parseStepMessage(e.data, e.source, win);
		if (dir) {
			stepScreen(dir);
			return;
		}
		const stuck = parseUnresponsiveMessage(e.data, e.source, win);
		if (stuck) {
			// Only the answer to the person's last choice counts
			if (stuck.key === pendingKey) quiet = stuck;
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
		// ...and to say again what it offers
		config = null;
		choices = {};
		pendingKey = null;
		quiet = null;
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

<svelte:window onmessage={onMessage} onkeydown={onKeydown} />

<!-- THE PREVIEW: ONE TOOLBAR OF THE BOARD (DEVICE, COMMENTS, THE SCREENS, THEN THE OPTIONS THAT APPLY TO THE SCREEN ON SHOW) AND THE MOCKUP IN A SANDBOXED FRAME, DRAWN INSIDE A DEVICE. THE WHOLE DEVICE SHOWS, AND THE MOCKUP SCROLLS INSIDE ITS SCREEN ONLY -->
<div class={cn('flex flex-col', flush && 'max-sm:-m-3.5')} data-testid="mockup-preview">
	<!-- ON A PHONE ALL ROWS SHARE THE SAME LEFT AND RIGHT EDGES: THE DEVICE SWITCH FILLS THE ROOM LEFT OF THE COMMENT BUTTONS, AND EVERY OPTION AND THE SCREEN STRIP RUN FULL WIDTH ON A ROW OF THEIR OWN -->
	<div
		class={cn(
			'flex flex-wrap items-center gap-2 rounded-t-lg border border-line bg-surface p-3 sm:gap-3',
			flush && 'max-sm:rounded-none max-sm:border-x-0 max-sm:border-t-0',
			sticky && 'sticky top-[65px] z-20 md:top-[73px]'
		)}
		data-testid="mockup-toolbar"
	>
		{#if showsSwitch(screens)}
			<div
				bind:this={switchRow}
				class="max-w-full [scrollbar-width:none]! overflow-x-auto overflow-y-hidden overscroll-x-contain max-sm:min-w-0 max-sm:flex-1 [&::-webkit-scrollbar]:hidden"
			>
				<SegmentedControl
					label="Device"
					value={device}
					{options}
					compactOnPhone
					class="max-sm:flex max-sm:w-full max-sm:[&>button]:min-w-0 max-sm:[&>button]:flex-1"
					onchange={(v) => (picked = v as ScreenKey)}
				/>
			</div>
		{/if}
		{#if toolbar}
			<div class="ml-auto flex items-center gap-2 max-sm:order-2">{@render toolbar()}</div>
		{/if}
		{#if config && config.screens.length > 1}
			<MockupScreenStrip
				class="basis-full max-sm:order-3"
				screens={config.screens}
				value={choices[SCREEN_OPTION] ?? config.screens[0].value}
				onpick={(v) => choose(SCREEN_OPTION, v)}
			/>
		{/if}
		<!-- THE OPTIONS THAT APPLY TO THE SCREEN ON SHOW, IN A ROW OF THEIR OWN BELOW THE SCREEN STRIP SO THE STRIP NEVER MOVES. NONE APPLIES: NO ROW. A HIDDEN OPTION KEEPS ITS VALUE -->
		{#if shownOptions.length}
			<div
				class="flex basis-full flex-wrap items-center gap-2 max-sm:order-4 sm:gap-3"
				data-testid="mockup-options"
			>
				{#each shownOptions as o (o.key)}
					<div class="max-sm:basis-full">
						{#if o.values.length <= 3}
							<SegmentedControl
								label={o.label}
								value={choices[o.key]}
								options={o.values}
								class="max-sm:flex max-sm:w-full max-sm:[&>button]:flex-1"
								onchange={(v) => choose(o.key, v)}
							/>
						{:else}
							<Select
								fill
								label={o.label}
								prefix={o.label}
								value={choices[o.key]}
								options={o.values}
								onchange={(v) => choose(o.key, v)}
							/>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
		<!-- A QUIET HINT WHEN THE LAST CHOICE CHANGED NOTHING IN THE PAGE. IT IS A STATUS LINE, NEVER AN ERROR, AND CLEARS ON THE NEXT CHOICE -->
		{#if quiet}
			<p
				role="status"
				class="basis-full text-sm text-muted max-sm:order-5"
				data-testid="mockup-unresponsive"
			>
				{quietText}
			</p>
		{/if}
	</div>
	<div
		bind:this={stage}
		class={cn(
			'relative isolate min-h-60 overflow-hidden rounded-b-lg border border-t-0 border-line bg-raised p-6 max-sm:p-3',
			flush && 'max-sm:rounded-b-xl max-sm:border-0'
		)}
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
