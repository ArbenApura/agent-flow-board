// A SIDEWAYS ROW THAT TELLS ITS PARENT WHERE IT CONTINUES (AFB-20261109-0715)
// Put `use:scrollFade` on the element that scrolls and give its parent `group/fade relative`. The action sets `data-fade-start` on the
// parent while the row has been scrolled away from its start, and `data-fade-end` while more of it lies beyond the right edge, so two
// fades drawn with `group-data-[fade-start]/fade:` and `group-data-[fade-end]/fade:` show a cut row as scrollable. A row that fits sets
// neither, so nothing is drawn on a wide screen.

// -- TYPES -- //
import type { Action } from 'svelte/action';

// -- FUNCTIONS -- //

export const scrollFade: Action<HTMLElement> = (node) => {
	const box = node.parentElement;
	if (!box) return;

	function update() {
		if (!box) return;
		const more = node.scrollWidth - node.clientWidth > 4;
		box.toggleAttribute('data-fade-start', more && node.scrollLeft > 4);
		box.toggleAttribute(
			'data-fade-end',
			more && node.scrollLeft + node.clientWidth < node.scrollWidth - 4
		);
	}

	update();
	node.addEventListener('scroll', update, { passive: true });
	// The row itself changes size with the window, and its content changes size with the data
	const watch = new ResizeObserver(update);
	watch.observe(node);
	for (const child of node.children) watch.observe(child);

	return {
		destroy() {
			node.removeEventListener('scroll', update);
			watch.disconnect();
			box.removeAttribute('data-fade-start');
			box.removeAttribute('data-fade-end');
		}
	};
};
