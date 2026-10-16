// SCROLL LOCK FOR THE PAGE BEHIND A MODAL. COUNTED, SO TWO OPEN LAYERS RELEASE ONLY WHEN BOTH CLOSE.

// -- STATES -- //

let locks = 0;
let saved: { overflow: string; paddingRight: string } | null = null;

// -- FUNCTIONS -- //

export function lockScroll(): void {
	if (typeof document === 'undefined') return;
	if (locks++ > 0) return;
	const body = document.body;
	saved = { overflow: body.style.overflow, paddingRight: body.style.paddingRight };
	// Keep the layout from jumping when the scrollbar disappears
	const bar = window.innerWidth - document.documentElement.clientWidth;
	body.style.overflow = 'hidden';
	if (bar > 0) body.style.paddingRight = `${bar}px`;
}

export function unlockScroll(): void {
	if (typeof document === 'undefined' || locks === 0) return;
	if (--locks > 0) return;
	if (saved) {
		document.body.style.overflow = saved.overflow;
		document.body.style.paddingRight = saved.paddingRight;
		saved = null;
	}
}

/** As an action: the page is locked while the element exists. */
export function scrollLock(_node: HTMLElement) {
	lockScroll();
	return { destroy: unlockScroll };
}
