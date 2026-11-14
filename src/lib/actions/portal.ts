// PORTAL: MOVES AN ELEMENT TO <body> SO IT STACKS ABOVE EVERYTHING. THE THEME MODE LIVES ON <html>, SO TOKENS STILL APPLY.
// While an element is in full screen only its own subtree is drawn, so the portal moves into that element and back to <body> afterwards.

// -- FUNCTIONS -- //

/** Where a portalled element belongs now: the element in full screen, otherwise the body. */
export function portalTarget(
	fullscreen: Element | null | undefined,
	body: HTMLElement
): HTMLElement {
	return fullscreen && fullscreen !== body && 'appendChild' in fullscreen
		? (fullscreen as HTMLElement)
		: body;
}

export function portal(node: HTMLElement) {
	let host = portalTarget(document.fullscreenElement, document.body);
	host.appendChild(node);
	// Moving the node keeps its state, so an open menu or modal stays open when full screen starts or ends
	const follow = () => {
		const next = portalTarget(document.fullscreenElement, document.body);
		// A node that holds the full screen element cannot be moved into it
		if (next === host || node.contains(next)) return;
		host = next;
		host.appendChild(node);
	};
	document.addEventListener('fullscreenchange', follow);
	return {
		destroy() {
			document.removeEventListener('fullscreenchange', follow);
			node.remove();
		}
	};
}
