<script lang="ts">
	// IMPORTED DEP-MODULES
	import { onMount } from 'svelte';
	// IMPORTED MODULES
	import { cn } from '#lib/ui/cn.js';

	// -- REQUIRED PROPS -- //

	let {
		root,
		line = 81
	}: {
		/** The box that holds the note's text, rendered or in the editor. Its headings are read as the text changes. */
		root: HTMLElement | undefined;
		/** Pixels from the top of the window where a heading counts as current and where a jump lands it. */
		line?: number;
	} = $props();

	// -- STATES -- //

	let items = $state<{ text: string; level: number }[]>([]);
	let activeIndex = $state(-1);
	/** The heading elements behind items, for the scroll position and the jump. Not reactive. */
	let els: HTMLElement[] = [];
	let frame = 0;
	let readTimer: ReturnType<typeof setTimeout> | undefined;

	// -- REACTIVE STATEMENTS -- //

	// The headings are read again whenever the text under the root changes, a little after the last keystroke
	$effect(() => {
		const box = root;
		if (!box) return;
		read(box);
		const watch = new MutationObserver(() => {
			clearTimeout(readTimer);
			readTimer = setTimeout(() => read(box), 300);
		});
		watch.observe(box, { childList: true, subtree: true, characterData: true });
		return () => {
			watch.disconnect();
			clearTimeout(readTimer);
		};
	});

	// -- FUNCTIONS -- //

	const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

	function read(box: HTMLElement) {
		els = [...box.querySelectorAll<HTMLElement>('.md :is(h1, h2, h3)')].filter(
			(el) => (el.textContent ?? '').trim() !== ''
		);
		items = els.map((el) => ({
			text: (el.textContent ?? '').trim(),
			level: el.tagName === 'H3' ? 3 : 2
		}));
		measure();
	}

	/** The last heading above the sticky line is the current one. */
	function measure() {
		let index = -1;
		els.forEach((h, i) => {
			if (h.getBoundingClientRect().top <= line + 1) index = i;
		});
		// At the very bottom of a short page the last headings can never reach the line, so the last one counts
		const bottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 2;
		if (bottom && els.length > 0 && index >= 0) index = els.length - 1;
		activeIndex = index < 0 && els.length > 0 ? 0 : index;
	}

	function schedule() {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			measure();
		});
	}

	function jump(index: number) {
		const el = els[index];
		if (!el) return;
		const top = el.getBoundingClientRect().top + scrollY - line;
		scrollTo({ top: Math.max(0, top), behavior: reduced() ? 'auto' : 'smooth' });
	}

	// -- LIFECYCLES -- //

	onMount(() => {
		addEventListener('scroll', schedule, { passive: true });
		addEventListener('resize', schedule);
		return () => {
			removeEventListener('scroll', schedule);
			removeEventListener('resize', schedule);
			cancelAnimationFrame(frame);
		};
	});
</script>

<!-- ON THIS PAGE: THE HEADINGS OF THE NOTE, FROM XL UP AND ONLY WITH TWO OR MORE. READ FROM THE TEXT, SO THE ENTRIES ARE BUTTONS -->
{#if items.length > 1}
	<nav
		aria-label="On this page"
		class="sticky top-[73px] hidden rounded-xl border border-line bg-surface p-4 shadow-[var(--elev-1)] xl:block"
		data-testid="note-outline"
	>
		<h2 class="mb-2 text-xs font-medium text-muted">On this page</h2>
		<ul class="flex flex-col border-l border-line">
			{#each items as h, i (i)}
				<li>
					<button
						type="button"
						aria-current={activeIndex === i ? 'location' : undefined}
						onclick={() => jump(i)}
						class={cn(
							'-ml-px flex min-h-10 w-full cursor-pointer items-center border-l-2 py-1.5 pr-2 text-left text-sm break-words hover:text-ink',
							h.level === 3 ? 'pl-6' : 'pl-3',
							activeIndex === i
								? 'border-accent font-medium text-ink'
								: 'border-transparent text-muted'
						)}
					>
						{h.text}
					</button>
				</li>
			{/each}
		</ul>
	</nav>
{/if}
