// THE STYLE RULES AN ORG PALETTE BECOMES (SPEC 11)
// The values come from the palette generator and are checked once more here, so only a six digit colour can ever reach a page.

// -- TYPES -- //
import type { OrgPalette } from '../server/db/schema/core';
import type { Palette } from './palette';

// -- CONSTANTS -- //

const HEX = /^#[0-9a-fA-F]{6}$/;
const KEYS = ['--accent', '--accent-ink', '--accent-soft', '--accent-text'] as const;

// -- FUNCTIONS -- //

/** The four colour variables of one mode, as a record the database can keep. */
export function paletteVars(p: Palette, mode: 'light' | 'dark'): Record<string, string> {
	const m = p[mode];
	return {
		'--accent': m.accent,
		'--accent-ink': m.accentInk,
		'--accent-soft': m.accentSoft,
		'--accent-text': m.accentText
	};
}

/** What the database keeps of a generated palette. */
export const storedPalette = (p: Palette): OrgPalette => ({
	seed: p.seed,
	light: paletteVars(p, 'light'),
	dark: paletteVars(p, 'dark')
});

const declarations = (vars: Record<string, string>): string =>
	KEYS.filter((k) => HEX.test(vars?.[k] ?? ''))
		.map((k) => `${k}:${vars[k]}`)
		.join(';');

/** CSS for one palette in both modes, or an empty string when it holds nothing usable. */
export function paletteCss(p: OrgPalette | null | undefined): string {
	if (!p) return '';
	const light = declarations(p.light);
	const dark = declarations(p.dark);
	// Written as html:root and html[data-mode] so they outrank the token rules of the stylesheet whichever loads first
	return `${light ? `html:root,html[data-mode='light']{${light}}` : ''}${dark ? `html[data-mode='dark']{${dark}}` : ''}`;
}

/**
 * The accent of one organisation for a small tile, as inline custom properties for both modes.
 * A tile of another organisation (a list, a switcher) cannot read the page accent, which belongs to the current organisation.
 */
export function tileStyle(p: OrgPalette | null | undefined): string {
	if (!p) return '';
	const out: string[] = [];
	for (const mode of ['light', 'dark'] as const) {
		for (const k of ['--accent', '--accent-soft', '--accent-text'] as const) {
			const v = p[mode]?.[k] ?? '';
			if (HEX.test(v)) out.push(`--tile${k.slice(1)}-${mode}:${v}`);
		}
	}
	return out.join(';');
}

/** The palettes in order, a later one over an earlier one. The app passes the organisation's palette only. */
export const styleFor = (...palettes: (OrgPalette | null | undefined)[]): string =>
	palettes.map(paletteCss).join('');
