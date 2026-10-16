// PORTAL: MOVES AN ELEMENT TO <body> SO IT STACKS ABOVE EVERYTHING. THE THEME MODE LIVES ON <html>, SO TOKENS STILL APPLY.

// -- FUNCTIONS -- //

export function portal(node: HTMLElement) {
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		}
	};
}
