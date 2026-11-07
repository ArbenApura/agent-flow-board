<script lang="ts">
	// -- MODULES -- //
	import { addressToShow, mayLoad } from '#lib/board/thumbLoad.js';
	import { thumbSlots } from '#lib/board/thumbSlots.svelte.js';
	// -- DEP-COMPONENTS -- //
	import PanelsTopLeft from '@lucide/svelte/icons/panels-top-left';

	// -- REQUIRED PROPS -- //

	let {
		id,
		src,
		live
	}: {
		/** The mockup's id, which names this card's slot among the live frames. */
		id: string;
		/** The 5 minute signed address of the screenshot, or of the live preview page when there is no screenshot. */
		src: string;
		live: boolean;
	} = $props();

	// -- CONSTANTS -- //

	/** The live preview is drawn at a laptop screen and shrunk into the card, so the card shows a whole page. */
	const PAGE_WIDTH = 1280;

	// -- STATES -- //

	let box = $state<HTMLElement>();
	let near = $state(false);
	let distance = $state(0);
	let width = $state(0);
	/** The address this card loaded with. It changes only when another file is shown, never when the same file is signed again. */
	let shown = $state<string | null>(null);
	/** The address lasts 5 minutes, so a card left open for longer falls back to the placeholder instead of a broken picture. */
	let broken = $state(false);

	// -- REACTIVE STATES -- //

	const scale = $derived(width > 0 ? width / PAGE_WIDTH : 0);
	const framed = $derived(live && shown !== null && thumbSlots.has(id));

	// -- REACTIVE STATEMENTS -- //

	// A new file shows from the start, and a new signature for the same file changes nothing
	$effect(() => {
		const incoming = src;
		if (shown === null) return;
		const next = addressToShow(shown, incoming);
		if (next !== shown) {
			shown = next;
			broken = false;
		}
	});

	// Nothing loads until the card is within one screen of the viewport and its address has at least 30 seconds left
	$effect(() => {
		if (!near || broken) return;
		const needsSlot = live && !thumbSlots.has(id);
		if (shown !== null && !needsSlot) return;
		if (!mayLoad(src, Date.now())) return;
		if (live && !thumbSlots.request(id, distance)) return;
		// A card that takes a slot again after losing it loads with the address it has now, not the one it first loaded with
		shown = src;
	});

	// A card that now has a screenshot no longer needs a live frame, so its slot goes to another card
	$effect(() => {
		if (!live) thumbSlots.release(id);
	});

	// -- LIFECYCLES -- //

	$effect(() => {
		const el = box;
		if (!el) return;
		const watchSize = new ResizeObserver(([entry]) => (width = entry.contentRect.width));
		const watchView = new IntersectionObserver(
			([entry]) => {
				near = entry.isIntersecting;
				const r = entry.boundingClientRect;
				distance = Math.abs(r.top + r.height / 2 - window.innerHeight / 2);
				// Steps in the threshold list make this run while the card moves, so a card with a slot keeps a current distance
				thumbSlots.touch(id, distance);
			},
			{ rootMargin: '100% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] }
		);
		watchSize.observe(el);
		watchView.observe(el);
		return () => {
			watchSize.disconnect();
			watchView.disconnect();
			thumbSlots.release(id);
		};
	});
</script>

<!-- THE PICTURE OF A MOCKUP CARD: THE SCREENSHOT, OR A LIVE PREVIEW THAT RUNS NO CODE, OVER A QUIET PLACEHOLDER THAT A FAILED OR EMPTY PAGE LEAVES VISIBLE -->
<span
	bind:this={box}
	class="relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-lg border border-line bg-raised"
	data-testid="mockup-thumb"
	data-card-preview
>
	<PanelsTopLeft size={24} class="text-muted" aria-hidden="true" />
	{#if shown !== null && !broken}
		{#if live}
			{#if framed && scale > 0}
				<!-- THE PREVIEW IS DRAWN AT THE SIZE OF A LAPTOP SCREEN AND SCALED TO THE CARD. BOTH ARE RUNTIME VALUES. THE FRAME IS SANDBOXED WITH NO FLAGS, INERT AND NOT FOCUSABLE -->
				<iframe
					src={shown}
					title=""
					sandbox=""
					tabindex="-1"
					aria-hidden="true"
					inert
					class="pointer-events-none absolute top-0 left-0 origin-top-left border-0 bg-transparent"
					style:width="{PAGE_WIDTH}px"
					style:height="{PAGE_WIDTH * 0.625}px"
					style:transform="scale({scale})"
				></iframe>
			{/if}
		{:else}
			<img
				src={shown}
				alt=""
				class="absolute inset-0 size-full object-cover object-top"
				onerror={() => (broken = true)}
			/>
		{/if}
	{/if}
</span>
