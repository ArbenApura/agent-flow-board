// FOCUS TRAP FOR DIALOGS AND DRAWERS. FOCUS MOVES IN ON OPEN, TAB AND SHIFT+TAB WRAP, FOCUS RETURNS ON CLOSE.

// -- CONSTANTS -- //

const FOCUSABLE = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled]):not([type=hidden])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])'
].join(',');

// -- FUNCTIONS -- //

export function focusableIn(node: HTMLElement): HTMLElement[] {
	return [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
		(el) => el.offsetParent !== null || el === document.activeElement
	);
}

export function focusTrap(node: HTMLElement) {
	const previous = document.activeElement as HTMLElement | null;

	function onKeyDown(e: KeyboardEvent) {
		if (e.key !== 'Tab') return;
		const items = focusableIn(node);
		if (items.length === 0) {
			e.preventDefault();
			node.focus();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && (active === first || !node.contains(active))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && (active === last || !node.contains(active))) {
			e.preventDefault();
			first.focus();
		}
	}

	// A dialog without a focusable child still has to hold focus
	if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
	const target =
		node.querySelector<HTMLElement>('[data-autofocus]') ?? focusableIn(node)[0] ?? node;
	queueMicrotask(() => target.focus({ preventScroll: true }));
	node.addEventListener('keydown', onKeyDown);

	return {
		destroy() {
			node.removeEventListener('keydown', onKeyDown);
			if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
		}
	};
}
