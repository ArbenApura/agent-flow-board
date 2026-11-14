// DRAG AND DROP FOR THE BOARD, AS TWO SVELTE ACTIONS AND ONE SHARED STATE
// `use:draggable` marks a card and `use:dropzone` marks a column. The shared state lets a column show it is the target.

// IMPORTED DEP-TYPES
import type { Action } from 'svelte/action';

// -- TYPES -- //

export type DropOptions = {
	/** Unique per column, for example "status:IN PROGRESS". */
	zone: string;
	disabled?: boolean;
	ondrop: (id: string) => void;
};

// -- STATES -- //

export const drag = $state<{ id: string; zone: string }>({ id: '', zone: '' });

// -- FUNCTIONS -- //

function reset() {
	drag.id = '';
	drag.zone = '';
}

export const draggable: Action<HTMLElement, { id: string; disabled?: boolean }> = (
	node,
	initial
) => {
	let opts = initial;
	const apply = () => {
		node.draggable = !opts.disabled;
	};
	const start = (e: DragEvent) => {
		if (opts.disabled) return;
		drag.id = opts.id;
		e.dataTransfer?.setData('text/plain', opts.id);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
		// Dim the source a frame later, so the drag image is taken from the full card
		requestAnimationFrame(() => node.classList.add('opacity-40', 'scale-[0.98]'));
	};
	const end = () => {
		node.classList.remove('opacity-40', 'scale-[0.98]');
		reset();
	};
	apply();
	node.addEventListener('dragstart', start);
	node.addEventListener('dragend', end);
	return {
		update(next) {
			opts = next;
			apply();
		},
		destroy() {
			node.removeEventListener('dragstart', start);
			node.removeEventListener('dragend', end);
		}
	};
};

export const dropzone: Action<HTMLElement, DropOptions> = (node, initial) => {
	let opts = initial;
	const over = (e: DragEvent) => {
		if (opts.disabled || !drag.id) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		drag.zone = opts.zone;
	};
	const leave = (e: DragEvent) => {
		if (!node.contains(e.relatedTarget as Node | null) && drag.zone === opts.zone) drag.zone = '';
	};
	const drop = (e: DragEvent) => {
		if (opts.disabled || !drag.id) return;
		e.preventDefault();
		const id = drag.id;
		reset();
		opts.ondrop(id);
	};
	node.addEventListener('dragover', over);
	node.addEventListener('dragleave', leave);
	node.addEventListener('drop', drop);
	return {
		update(next) {
			opts = next;
		},
		destroy() {
			node.removeEventListener('dragover', over);
			node.removeEventListener('dragleave', leave);
			node.removeEventListener('drop', drop);
		}
	};
};
