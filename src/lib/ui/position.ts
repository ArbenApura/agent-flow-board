// FLOATING PANEL POSITION. PLACES A PANEL BELOW OR ABOVE ITS ANCHOR, ALIGNED TO THE START OR END, AND FLIPS WHEN THERE IS NO ROOM.

// -- TYPES -- //

export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'top' | 'bottom';
export type Box = { left: number; top: number; width: number; height: number };
export type Placed = { x: number; y: number; placement: Placement };

// -- CONSTANTS -- //

const GAP = 6;
const MARGIN = 8;

// -- FUNCTIONS -- //

/** Pure so it can be unit tested. Viewport size is passed in. */
export function place(
	anchor: Box,
	panel: { width: number; height: number },
	viewport: { width: number; height: number },
	preferred: Placement = 'bottom-start'
): Placed {
	const wantsTop = preferred.startsWith('top');
	const roomBelow = viewport.height - (anchor.top + anchor.height) - GAP - MARGIN;
	const roomAbove = anchor.top - GAP - MARGIN;
	// Flip when the preferred side is too small and the other side fits better
	const top = wantsTop
		? !(roomAbove < panel.height && roomBelow > roomAbove)
		: roomBelow < panel.height && roomAbove > roomBelow;
	const align = preferred.endsWith('end')
		? 'end'
		: preferred.endsWith('start')
			? 'start'
			: 'center';
	let x =
		align === 'end'
			? anchor.left + anchor.width - panel.width
			: align === 'center'
				? anchor.left + anchor.width / 2 - panel.width / 2
				: anchor.left;
	x = Math.min(Math.max(MARGIN, x), Math.max(MARGIN, viewport.width - panel.width - MARGIN));
	const y = top ? anchor.top - panel.height - GAP : anchor.top + anchor.height + GAP;
	return {
		x,
		y: Math.max(MARGIN, y),
		placement: ((top ? 'top' : 'bottom') + (align === 'center' ? '' : `-${align}`)) as Placement
	};
}

export function boxOf(el: HTMLElement): Box {
	const r = el.getBoundingClientRect();
	return { left: r.left, top: r.top, width: r.width, height: r.height };
}
