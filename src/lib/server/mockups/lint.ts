// THE FAITHFUL RENDERING CHECK: READS A SAVED MOCKUP OR KIT AND SAYS IN PLAIN WORDS WHAT WILL NOT RENDER IN THE SANDBOX (AFB-20261107-1128)
// It never blocks a save, never stores anything and never throws. A mockup runs sandboxed with no network, so a font, icon or
// picture loaded by address silently becomes the system font or nothing. Each warning says what and what to do about it.

// -- TYPES -- //

export type KitFacts = {
	/** The font families the kit embeds. */
	families: string[];
	/** The colours the kit writes, as lowercase six digit hex or rgb text. Empty when the kit has none. */
	palette: Set<string>;
};

// -- CONSTANTS -- //

/** Only this much of a page is read, after long data: addresses are cut short, so a huge or hostile page stays fast. */
const MAX_READ = 2_000_000;
const MAX_BLOCKS = 300;
const MARKER_START = '<!--afb-kit:start-->';
const MARKER_END = '<!--afb-kit:end-->';
const GENERIC = new Set([
	'serif',
	'sans-serif',
	'monospace',
	'cursive',
	'fantasy',
	'system-ui',
	'ui-sans-serif',
	'ui-serif',
	'ui-monospace',
	'ui-rounded',
	'emoji',
	'math',
	'fangsong',
	'inherit',
	'initial',
	'unset',
	'revert',
	'-apple-system',
	'blinkmacsystemfont'
]);
const ICON_FONT =
	/(material|font\s?awesome|fontawesome|bootstrap-icons|phosphor|remixicon|ionicons|feather|tabler|icomoon|glyphicons|boxicons|line-awesome)/i;
const ICON_CLASS =
	/\bclass\s*=\s*["'][^"']{0,400}?\b(fa[srlbd]?|fa-[a-z0-9-]+|material-icons[a-z-]*|material-symbols[a-z-]*|bi-[a-z0-9-]+|mdi-[a-z0-9-]+|ti-[a-z0-9-]+|ph-[a-z0-9-]+|ri-[a-z0-9-]+|glyphicon-[a-z0-9-]+)\b/i;
const SYMBOL_ICONS = /[\u2713\u2714\u2715\u2716\u2717\u2718\u2605\u2606\u2630\u2699\u2302\u2315]/u;
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const NOT_ICONS = new Set(['\u00a9', '\u00ae', '\u2122']);

// -- FUNCTIONS -- //

/** The page with every long data: address cut short and cut to the read limit. The start of an address stays, so embedded files are still seen. */
function shrink(html: string): string {
	// Long runs of whitespace become one space: the patterns below put whitespace next to optional quotes, and a run of thousands
	// of spaces would otherwise be tried at every split
	return html
		.slice(0, MAX_READ * 8)
		.replace(/data:[^"')\s]{64,}/g, 'data:x')
		.replace(/\s{12,}/g, ' ')
		.slice(0, MAX_READ);
}

/** A fragment of the page that is echoed in a warning: printable text only, cut by code points. The answer is stored with the request. */
function clean(text: string, max = 40): string {
	return [...text]
		.filter((c) => c >= ' ' && c !== '\u007f' && !/[\ud800-\udfff]/.test(c))
		.slice(0, max)
		.join('');
}

const unique = <T>(list: T[]): T[] => [...new Set(list)];
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const hostOf = (address: string) => {
	try {
		return clean(new URL(address.startsWith('//') ? `https:${address}` : address).host);
	} catch {
		return clean(address);
	}
};

/** The families a page embeds with a data: font file, and the families it declares with a file loaded by address. */
function embeddedFamilies(css: string): { embedded: string[]; byAddress: string[] } {
	const embedded: string[] = [];
	const byAddress: string[] = [];
	// A few hundred blocks at most, each read in a window, so a page made of nothing but openers stays fast
	let seen = 0;
	for (const open of css.matchAll(/@font-face\s*\{/gi)) {
		if (++seen > MAX_BLOCKS) break;
		const window = css.slice(open.index, open.index + 4000);
		const close = window.indexOf('}');
		const block = close === -1 ? window : window.slice(0, close + 1);
		const family = /font-family\s*:\s*["']?([^;"'}]+)/i.exec(block)?.[1]?.trim();
		if (!family) continue;
		(/url\(\s*["']?data:/i.test(block) ? embedded : byAddress).push(family.toLowerCase());
	}
	return { embedded, byAddress };
}

/** The first family of every font-family rule, without the generic ones and without values read from a variable. */
function familiesUsed(css: string): string[] {
	const used: string[] = [];
	for (const m of css.matchAll(/(?<![-\w])font-family\s*:\s*([^;}{]{1,300})/gi)) {
		const first = m[1]
			.split(',')[0]
			.trim()
			.replace(/^["']|["']$/g, '');
		if (!first || first.startsWith('var(') || GENERIC.has(first.toLowerCase())) continue;
		used.push(first);
	}
	return unique(used);
}

/** The style rules and style attributes of a page, where colours are written. */
function cssOf(html: string): string {
	const parts: string[] = [];
	// Style blocks are found with forward searches, so a page made of nothing but openers is read once and not once per opener
	const lower = html.replace(/[A-Z]/g, (c) => c.toLowerCase());
	let from = 0;
	for (let i = 0; i < MAX_BLOCKS * 10; i++) {
		const start = lower.indexOf('<style', from);
		if (start === -1) break;
		const bodyStart = lower.indexOf('>', start);
		if (bodyStart === -1) break;
		const end = lower.indexOf('</style>', bodyStart);
		parts.push(html.slice(bodyStart + 1, end === -1 ? undefined : end));
		if (end === -1) break;
		from = end + 8;
	}
	for (const m of html.matchAll(/\sstyle\s*=\s*"([^"]{0,2000})"/gi)) parts.push(m[1]);
	return parts.join('\n');
}

/** Every colour written as a literal in some css, as lowercase six digit hex or compact rgb text. */
function coloursIn(css: string): string[] {
	const found: string[] = [];
	for (const m of css.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
		let h = m[1].toLowerCase();
		if (![3, 4, 6, 8].includes(h.length)) continue;
		if (h.length <= 4) h = [...h.slice(0, 3)].map((c) => c + c).join('');
		found.push(`#${h.slice(0, 6)}`);
	}
	for (const m of css.matchAll(/\b(?:rgba?|hsla?)\(\s*[\d.%\s,/-]{3,40}\)/gi))
		found.push(m[0].toLowerCase().replace(/\s+/g, ''));
	return found;
}

/** What the project's kit embeds and the colours it writes, for checking a mockup against it. */
export function kitFacts(kitHtml: string): KitFacts {
	try {
		const text = shrink(kitHtml);
		const start = text.indexOf(MARKER_START);
		const end = text.indexOf(MARKER_END);
		const head = start !== -1 && end > start ? text.slice(start, end) : text;
		const css = cssOf(head);
		return {
			families: unique(embeddedFamilies(head + css).embedded),
			palette: new Set(coloursIn(css))
		};
	} catch {
		return { families: [], palette: new Set() };
	}
}

/** Addresses loaded from the network, by what loads them. The sandbox has no network, so none of them ever loads. */
function networkWarnings(text: string): string[] {
	const found: { kind: string; address: string }[] = [];
	const add = (kind: string, address: string) => found.push({ kind, address });
	for (const m of text.matchAll(
		/@import\s{1,12}(?:url\(\s{0,12})?["']?\s{0,12}((?:https?:)?\/\/[^"')\s;]+)/gi
	))
		add('stylesheet', m[1]);
	for (const m of text.matchAll(/url\(\s{0,12}["']?\s{0,12}((?:https?:)?\/\/[^"')\s]+)/gi))
		add('font or image', m[1]);
	// Each tag is read from its own piece of the page, up to a fixed number of tags, so the work grows with the page and no further
	let tags = 0;
	for (const piece of text.split('<')) {
		if (++tags > MAX_BLOCKS * 100) break;
		const tag = /^(link|script|img|source|iframe|video|audio|image|use)\b([^>]{0,600})/i.exec(
			piece
		);
		if (!tag) continue;
		const ref = /\b(?:src|href|xlink:href)\s*=\s*["']?\s*((?:https?:)?\/\/[^"'\s>]+)/i.exec(tag[2]);
		if (!ref) continue;
		const name = tag[1].toLowerCase();
		add(
			name === 'link'
				? 'stylesheet or font'
				: name === 'script'
					? 'script'
					: name === 'use'
						? 'icon'
						: 'image',
			ref[1]
		);
	}
	const byKind = new Map<string, string[]>();
	for (const f of found) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f.address]);
	return [...byKind].map(([kind, list]) => {
		const hosts = unique(list.map(hostOf)).slice(0, 3).join(', ');
		return `${plural(list.length, 'address', 'addresses')} ${list.length === 1 ? 'loads' : 'load'} a ${kind} from the network (${hosts}). The page runs sandboxed with no network, so it will not load. Put it in the page itself: a data: font, a data: image or an inline vector.`;
	});
}

/** The page without its script, style and svg blocks, cut with a few forward searches so the work grows with the page. */
function withoutBlocks(html: string, tag: string): string {
	// Lowercase letters of the alphabet only, so the text keeps its length and the positions stay true
	const lower = html.replace(/[A-Z]/g, (c) => c.toLowerCase());
	const open = `<${tag}`;
	const close = `</${tag}>`;
	let out = '';
	let from = 0;
	for (let i = 0; i < MAX_BLOCKS * 10; i++) {
		const start = lower.indexOf(open, from);
		if (start === -1) break;
		out += html.slice(from, start) + ' ';
		const end = lower.indexOf(close, start);
		if (end === -1) return out;
		from = end + close.length;
	}
	return out + html.slice(from);
}

/** The text a person sees: no script, style or svg, and no tags. Linear in the size of the page. */
function visibleText(html: string): string {
	let text = html;
	for (const tag of ['script', 'style', 'svg']) text = withoutBlocks(text, tag);
	let out = '';
	for (const [i, piece] of text.split('<').entries()) {
		const end = piece.indexOf('>');
		out += i === 0 ? piece : end === -1 ? piece : `${piece.slice(end + 1)} `;
	}
	return out;
}

/** Emoji and symbol characters in the visible text, where icons belong. */
function symbolWarning(html: string): string | null {
	const visible = visibleText(html);
	const hits: string[] = [];
	for (const ch of visible) {
		if (NOT_ICONS.has(ch)) continue;
		if (PICTOGRAPH.test(ch) || SYMBOL_ICONS.test(ch)) hits.push(ch);
		if (hits.length >= 500) break;
	}
	if (hits.length === 0) return null;
	// Named by code point, not echoed: the answer is stored with the request and some databases cannot hold every character
	const sample = unique(hits)
		.slice(0, 4)
		.map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`)
		.join(' ');
	return `${plural(hits.length, 'emoji or symbol character', 'emoji or symbol characters')} (${sample}) ${hits.length === 1 ? 'stands' : 'stand'} in for an icon. Use the project's icons as inline vector images from the kit's icon sprite instead.`;
}

/**
 * The warnings for a mockup page, in plain words. With the project's kit facts it also checks the fonts and colours against the
 * kit. An empty list means nothing was found. This never throws.
 */
export function lintMockupHtml(html: string, kit?: KitFacts | null): string[] {
	try {
		const text = shrink(html);
		const warnings: string[] = [...networkWarnings(text)];
		const css = cssOf(text);
		const { embedded } = embeddedFamilies(text + css);
		const used = familiesUsed(css);
		const iconFonts = used.filter((f) => ICON_FONT.test(f) && !embedded.includes(f.toLowerCase()));
		if (iconFonts.length)
			warnings.push(
				`The page uses the icon font ${iconFonts
					.slice(0, 3)
					.map((f) => clean(f, 60))
					.join(
						', '
					)} with no font file embedded behind it, so its icons show as empty boxes or nothing. Draw the icons as inline vector images from the kit's icon sprite.`
			);
		else if (ICON_CLASS.test(text) && !embedded.some((f) => ICON_FONT.test(f)))
			warnings.push(
				"The page uses icon font classes (like fa-home or material-icons) with no icon font embedded, so the icons will not show. Draw them as inline vector images from the kit's icon sprite."
			);
		if (kit && kit.families.length) {
			const allowed = new Set([...kit.families, ...embedded]);
			const off = used.filter(
				(f) => !allowed.has(f.toLowerCase()) && !(ICON_FONT.test(f) && iconFonts.includes(f))
			);
			if (off.length)
				warnings.push(
					`The page uses the font ${off
						.slice(0, 3)
						.map((f) => clean(f, 60))
						.join(', ')}, which is not one of the project's fonts (${kit.families
						.slice(0, 4)
						.map((f) => clean(f, 60))
						.join(', ')}). Use only the kit's font families.`
				);
		}
		const symbols = symbolWarning(text);
		if (symbols) warnings.push(symbols);
		if (kit && kit.palette.size) {
			const own = unique(coloursIn(css)).filter((c) => !kit.palette.has(c));
			if (own.length)
				warnings.push(
					`${plural(own.length, 'colour is', 'colours are')} written as a literal value that is not one of the project's colours (like ${clean(own[0], 30)}). Use the kit's colour tokens, such as var(--accent).`
				);
		}
		return warnings;
	} catch {
		return [];
	}
}

/** The warnings for a kit file: its fonts embedded, its icons present, both colour modes defined and its head marked. Never throws. */
export function lintKitHtml(html: string): string[] {
	try {
		const text = shrink(html);
		const warnings: string[] = [...networkWarnings(text)];
		const css = cssOf(text);
		const { embedded, byAddress } = embeddedFamilies(text + css);
		if (embedded.length === 0)
			warnings.push(
				byAddress.length
					? `The kit's fonts (${byAddress
							.slice(0, 3)
							.map((f) => clean(f, 60))
							.join(
								', '
							)}) are loaded by address, not embedded. Embed the real font files as data: addresses under the same family names.`
					: "The kit embeds no font file, so mockups fall back to the system font. Embed the project's real font files as data: addresses."
			);
		if (!/<symbol\b/i.test(text) && !/<svg\b/i.test(text))
			warnings.push(
				"The kit has no icons. Add the project's real icon set as inline vector images or one icon sprite, so mockups never draw lookalikes."
			);
		const dark =
			/\[data-(?:mode|theme)\s*=\s*["']?dark|\.dark\b|prefers-color-scheme\s*:\s*dark|color-scheme\s*:\s*dark/i;
		if (!dark.test(text))
			warnings.push(
				'The kit defines one colour mode only. Add the dark mode (or the mode the product has), so a mockup can show both.'
			);
		const start = text.indexOf(MARKER_START);
		if (start === -1 || text.indexOf(MARKER_END) <= start)
			warnings.push(
				`The kit has no head between ${MARKER_START} and ${MARKER_END}. Put the colour tokens, the embedded fonts and the icon sprite between them, so the board can add them to every mockup.`
			);
		return warnings;
	} catch {
		return [];
	}
}
