// OKLCH PALETTE GENERATOR WITH AA CONTRAST ENFORCEMENT (SPEC 11, ADR-012)

// -- TYPES -- //

export type Oklch = { l: number; c: number; h: number };
export type PaletteMode = {
	accent: string;
	accentInk: string;
	accentSoft: string;
	accentText: string;
	scale: Record<number, string>;
};
export type Palette = {
	seed: string;
	adjusted: boolean;
	light: PaletteMode;
	dark: PaletteMode;
	chart: { light: string[]; dark: string[] };
};
export type PairCheck = {
	name: string;
	fg: string;
	bg: string;
	ratio: number;
	need: number;
	pass: boolean;
};

// -- CONSTANTS -- //

/** Surfaces the generated colours must work on, taken from design/tokens.md. */
export const SURFACES = {
	light: { bg: '#f3f4f7', surface: '#ffffff', ink: '#14171c' },
	dark: { bg: '#0c0e11', surface: '#171b21', ink: '#f1f3f6' }
} as const;
export const AA_TEXT = 4.5;
export const AA_UI = 3;
const SCALE_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

// -- FUNCTIONS -- //

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

export function hexToRgb(hex: string): [number, number, number] {
	const h = hex.replace('#', '');
	const full = h.length === 3 ? [...h].map((x) => x + x).join('') : h;
	if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`Not a hex colour: ${hex}`);
	return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
	return (
		'#' +
		[r, g, b]
			.map((v) =>
				Math.round(clamp(v) * 255)
					.toString(16)
					.padStart(2, '0')
			)
			.join('')
	);
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export function hexToOklch(hex: string): Oklch {
	const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number];
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	return { l: L, c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
	const a = c * Math.cos((h * Math.PI) / 180);
	const b = c * Math.sin((h * Math.PI) / 180);
	const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
		-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
		-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
	];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.0005 && v <= 1.0005);

/** Converts to hex, lowering chroma until the colour fits the sRGB gamut. */
export function oklchToHex(color: Oklch): string {
	let c = color.c;
	let rgb = oklchToLinear({ ...color, c });
	for (let i = 0; i < 40 && !inGamut(rgb); i++) {
		c *= 0.93;
		rgb = oklchToLinear({ ...color, c });
	}
	return rgbToHex(rgb.map((v) => fromLinear(clamp(v))) as [number, number, number]);
}

export function luminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colours. */
export function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * Moves the lightness of a colour (hue and chroma kept) darker or lighter until it reaches the contrast against
 * every given background. Returns the original when it already passes.
 */
export function adjustForContrast(
	hex: string,
	backgrounds: string[],
	min: number,
	direction: 'darker' | 'lighter'
): string {
	const ok = (h: string) => backgrounds.every((bg) => contrast(h, bg) >= min);
	if (ok(hex)) return hex;
	const base = hexToOklch(hex);
	let lo = direction === 'darker' ? 0 : base.l;
	let hi = direction === 'darker' ? base.l : 1;
	let best = oklchToHex({ ...base, l: direction === 'darker' ? 0 : 1 });
	for (let i = 0; i < 30; i++) {
		const mid = (lo + hi) / 2;
		const candidate = oklchToHex({ ...base, l: mid });
		if (ok(candidate)) {
			best = candidate;
			// Passing: move back toward the original lightness to keep the colour as close as possible
			if (direction === 'darker') lo = mid;
			else hi = mid;
		} else if (direction === 'darker') hi = mid;
		else lo = mid;
	}
	return best;
}

function buildMode(seed: Oklch, mode: 'light' | 'dark'): PaletteMode {
	const s = SURFACES[mode];
	const hue = seed.h;
	const chroma = Math.min(seed.c, 0.2);
	// Fill colour: dark enough on light surfaces, light enough on dark surfaces, 3:1 against the page
	const target = mode === 'light' ? 0.52 : 0.74;
	let accent = oklchToHex({
		l: mode === 'light' ? Math.min(seed.l, target) : Math.max(seed.l, target),
		c: chroma,
		h: hue
	});
	const direction = mode === 'light' ? 'darker' : 'lighter';
	accent = adjustForContrast(accent, [s.surface, s.bg], AA_UI, direction);
	// Label on the fill: white on light, near-black on dark, and the fill is nudged until the label passes AA
	const ink = mode === 'light' ? '#ffffff' : '#071634';
	accent = adjustForContrast(accent, [ink], AA_TEXT, direction);
	const soft = oklchToHex({
		l: mode === 'light' ? 0.93 : 0.28,
		c: chroma * (mode === 'light' ? 0.22 : 0.45),
		h: hue
	});
	// Accent text on the soft tint and on the surface must pass AA
	const text = adjustForContrast(accent, [soft, s.surface], AA_TEXT, direction);
	const scale: Record<number, string> = {};
	SCALE_STEPS.forEach((step, i) => {
		const l = mode === 'light' ? 0.97 - i * 0.075 : 0.2 + i * 0.07;
		const bump = 0.35 + 0.65 * Math.sin((Math.PI * (i + 0.5)) / SCALE_STEPS.length);
		scale[step] = oklchToHex({ l: clamp(l, 0.12, 0.98), c: chroma * bump, h: hue });
	});
	return { accent, accentInk: ink, accentSoft: soft, accentText: text, scale };
}

/** Evenly spaced hues for charts, each adjusted to 3:1 against the surface. */
export function chartColours(mode: 'light' | 'dark', startHue: number, count = 8): string[] {
	const s = SURFACES[mode];
	return Array.from({ length: count }, (_, i) =>
		adjustForContrast(
			oklchToHex({
				l: mode === 'light' ? 0.55 : 0.75,
				c: 0.14,
				h: (startHue + (360 / count) * i) % 360
			}),
			[s.surface],
			AA_UI,
			mode === 'light' ? 'darker' : 'lighter'
		)
	);
}

/** Builds a full palette from one seed colour. A seed that would fail AA is adjusted and flagged. */
export function generatePalette(seedHex: string): Palette {
	const seed = hexToOklch(seedHex);
	const light = buildMode(seed, 'light');
	const dark = buildMode(seed, 'dark');
	return {
		seed: seedHex,
		// A seed is adjusted when it could not carry a white label at AA as a light mode fill
		adjusted: contrast(seedHex, '#ffffff') < AA_TEXT,
		light,
		dark,
		chart: { light: chartColours('light', seed.h), dark: chartColours('dark', seed.h) }
	};
}

/** Every pair a palette must satisfy, so tests and the settings page can show the results. */
export function checkPalette(p: Palette): PairCheck[] {
	const out: PairCheck[] = [];
	for (const mode of ['light', 'dark'] as const) {
		const m = p[mode];
		const s = SURFACES[mode];
		const add = (name: string, fg: string, bg: string, need: number) => {
			const ratio = contrast(fg, bg);
			out.push({
				name: `${mode} ${name}`,
				fg,
				bg,
				ratio: Math.round(ratio * 100) / 100,
				need,
				pass: ratio >= need
			});
		};
		add('accent-ink on accent', m.accentInk, m.accent, AA_TEXT);
		add('accent on surface', m.accent, s.surface, AA_UI);
		add('accent on page', m.accent, s.bg, AA_UI);
		add('accent-text on accent-soft', m.accentText, m.accentSoft, AA_TEXT);
		add('accent-text on surface', m.accentText, s.surface, AA_TEXT);
		p.chart[mode].forEach((c, i) => add(`chart ${i + 1} on surface`, c, s.surface, AA_UI));
	}
	return out;
}

/** CSS variable declarations for a generated palette, for the html element's style. */
export function paletteStyle(p: Palette, mode: 'light' | 'dark'): string {
	const m = p[mode];
	return `--accent:${m.accent};--accent-ink:${m.accentInk};--accent-soft:${m.accentSoft};--accent-text:${m.accentText};`;
}
