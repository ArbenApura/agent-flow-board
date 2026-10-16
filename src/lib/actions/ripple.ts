// RIPPLE: OUR OWN CLICK FEEDBACK. TOKEN COLOUR, REDUCED MOTION RESPECTED, KEYBOARD ACTIVATION STARTS FROM THE CENTRE.

// -- TYPES -- //

export type RippleOptions = { disabled?: boolean };

// -- FUNCTIONS -- //

export function ripple(node: HTMLElement, options: RippleOptions = {}) {
	let opts = options;

	function start(x: number, y: number) {
		if (opts.disabled) return;
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const rect = node.getBoundingClientRect();
		// The circle grows to cover the farthest corner from the origin
		const radius = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
		const dot = document.createElement('span');
		dot.setAttribute('aria-hidden', 'true');
		dot.dataset.ripple = '1';
		// DYNAMIC RUNTIME COORDINATES FOR THE CIRCLE, CANNOT BE EXPRESSED AS TAILWIND CLASSES
		dot.style.cssText = `position:absolute;pointer-events:none;border-radius:9999px;background:var(--ripple);left:${x - radius}px;top:${y - radius}px;width:${radius * 2}px;height:${radius * 2}px;`;
		node.appendChild(dot);
		const animation = dot.animate(
			[
				{ transform: 'scale(0)', opacity: 1 },
				{ transform: 'scale(1)', opacity: 0 }
			],
			{ duration: 450, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
		);
		animation.onfinish = () => dot.remove();
	}

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		const rect = node.getBoundingClientRect();
		start(e.clientX - rect.left, e.clientY - rect.top);
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
		const rect = node.getBoundingClientRect();
		start(rect.width / 2, rect.height / 2);
	}

	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('keydown', onKeyDown);

	return {
		update(next: RippleOptions = {}) {
			opts = next;
		},
		destroy() {
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('keydown', onKeyDown);
			node.querySelectorAll('[data-ripple]').forEach((d) => d.remove());
		}
	};
}
