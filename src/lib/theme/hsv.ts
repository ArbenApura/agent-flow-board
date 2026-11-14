// IMPORTED MODULES
import { hexToRgb, rgbToHex } from '#lib/theme/palette.js';

// -- TYPES -- //

/** Hue 0 to 360, saturation and value 0 to 1. */
export type Hsv = { h: number; s: number; v: number };

// -- FUNCTIONS -- //

export function hexToHsv(hex: string): Hsv {
	const [r, g, b] = hexToRgb(hex);
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	let h = 0;
	if (d > 0) {
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h = (h * 60 + 360) % 360;
	}
	return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToHex({ h, s, v }: Hsv): string {
	const f = (n: number) => {
		const k = (n + h / 60) % 6;
		return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
	};
	return rgbToHex([f(5), f(3), f(1)]);
}

// -- PICKER PAINT -- //

// The picker draws real colours by nature, so its gradients live here with the other colour code
export const hueGradient = 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)';

export const handleRing = '0 0 0 2px #fff, 0 0 0 3px #0008';

export const hueColour = (h: number) => `hsl(${h} 100% 50%)`;

export const areaGradient = (h: number) =>
	`linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColour(h)})`;
