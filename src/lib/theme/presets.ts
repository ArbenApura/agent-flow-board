// THE COLOUR CHOICES OF THE PALETTE PICKER (SPEC 11). THEME FILES MAY HOLD LITERAL COLOURS, COMPONENTS MAY NOT.

// -- CONSTANTS -- //

/** The default accent of every org and every person who has not chosen one (design/tokens.md). */
export const DEFAULT_ACCENT = '#2563eb';

export const PRESETS = [
	{ name: 'Blue', hex: '#2563eb' },
	{ name: 'Teal', hex: '#0d9488' },
	{ name: 'Green', hex: '#16a34a' },
	{ name: 'Violet', hex: '#7c3aed' },
	{ name: 'Rose', hex: '#e11d48' },
	{ name: 'Orange', hex: '#ea580c' },
	{ name: 'Slate', hex: '#475569' }
] as const;
