// WHERE A JUMP LANDS ON THE CONNECT PAGE: SCROLL CLEAR OF THE STICKY TOP BAR, MOVE FOCUS THERE AND MARK THE CARD FOR A MOMENT.
// The top bar is 65 px with its border, plus 8 px of air, so every target also carries scroll-mt-[65px] md:scroll-mt-[73px] (the 65 px phone bar is 57 px plus 8).

// -- CONSTANTS -- //

/** The accent border and the soft ring, held for a moment then eased away. The ! keeps the border colour over the card's own. */
const HIT = ['ring-4', 'ring-accent-soft', 'border-accent!'];
const EASE = ['transition-[box-shadow,border-color]', 'duration-500'];
const HOLD_MS = 1600;
const EASE_MS = 2300;
const SCROLL_FALLBACK_MS = 1100;

// -- FUNCTIONS -- //

const calm = () =>
	typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function mark(target: HTMLElement) {
	target.setAttribute('tabindex', '-1');
	// Focus moves there for a keyboard or screen reader person, without a second scroll
	target.focus({ preventScroll: true });
	target.classList.add(...EASE, ...HIT);
	setTimeout(() => target.classList.remove(...HIT), HOLD_MS);
	setTimeout(() => target.classList.remove(...EASE), EASE_MS);
}

/** Scrolls to the element and marks it once it has arrived. Under reduced motion the scroll is instant. */
export function jumpTo(target: HTMLElement | null | undefined) {
	if (!target) return;
	if (calm()) {
		target.scrollIntoView({ behavior: 'auto', block: 'start' });
		mark(target);
		return;
	}
	target.scrollIntoView({ behavior: 'smooth', block: 'start' });
	let done = false;
	const arrive = () => {
		if (done) return;
		done = true;
		mark(target);
	};
	if ('onscrollend' in window) window.addEventListener('scrollend', arrive, { once: true });
	setTimeout(arrive, SCROLL_FALLBACK_MS);
}
