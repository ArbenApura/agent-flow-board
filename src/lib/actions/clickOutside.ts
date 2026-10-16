// CLICK OUTSIDE: CALLS THE HANDLER WHEN A POINTER PRESS LANDS OUTSIDE THE ELEMENT (AND OUTSIDE ANY IGNORED ELEMENT).

// -- TYPES -- //

export type ClickOutsideOptions = {
	onOutside: () => void;
	ignore?: (HTMLElement | undefined | null)[];
};

// -- FUNCTIONS -- //

export function clickOutside(node: HTMLElement, options: ClickOutsideOptions) {
	let opts = options;

	function onDown(e: PointerEvent) {
		const target = e.target as Node | null;
		if (!target || node.contains(target)) return;
		if (opts.ignore?.some((el) => el?.contains(target))) return;
		opts.onOutside();
	}

	document.addEventListener('pointerdown', onDown, true);
	return {
		update(next: ClickOutsideOptions) {
			opts = next;
		},
		destroy() {
			document.removeEventListener('pointerdown', onDown, true);
		}
	};
}
