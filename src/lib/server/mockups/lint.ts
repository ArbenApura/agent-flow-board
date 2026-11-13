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
const MAX_READ = 8_000_000;
/** The page is cut here before anything else, so the work on a huge page stays bounded. The callers cut at the same 8 MB and say so in their warning. */
const PRE_SLICE = 16_000_000;
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
		.slice(0, PRE_SLICE)
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
	// Newer colour functions, which a Tailwind 4 stylesheet writes for its palette
	for (const m of css.matchAll(/\b(?:oklch|oklab|lch|lab)\(\s*[\d.%\s/-]{3,40}\)/gi))
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

/** Files a stylesheet loads by a relative or root-relative address. The sandbox has no network and no files, so none of them ever loads. */
function relativeUrlWarnings(text: string): string[] {
	const found: string[] = [];
	for (const m of text.matchAll(
		/url\(\s{0,12}["']?\s{0,12}(?!data:|#|%23|&(?:quot|#)|https?:|\/\/|var\()([^"')\s]{1,200})/gi
	)) {
		// Printable ASCII only, so a name in another script is never echoed into the stored answer
		if (!/^[\x21-\x7e]+$/.test(m[1])) continue;
		found.push(m[1]);
		if (found.length >= 500) break;
	}
	if (!found.length) return [];
	return [
		`${plural(found.length, 'file is', 'files are')} loaded by a relative address (like ${clean(found[0], 60)}), which the sandbox cannot load, so it shows as the system font or nothing. Embed it as a data: address, or remove the rule.`
	];
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
	return `${plural(hits.length, 'emoji or symbol character', 'emoji or symbol characters')} (${sample}) ${hits.length === 1 ? 'stands' : 'stand'} in for an icon. Use the project's own icons instead, copied as inline vector images (SVG).`;
}

// A control the page draws for the person to switch the colour mode, by what the page calls it
const OWN_MODE_SWITCH =
	/\b(?:id|class|aria-label|title)\s*=\s*["'][^"']{0,200}?(?:(?:theme|mode|dark|colou?r)[-_ ]?(?:toggle|switch(?:er)?)|(?:toggle|switch)[-_ ]?(?:theme|mode|dark)|light (?:and|or|\/) dark)/i;
// A bar or row of the page's own screens or states, by what the page calls it
const OWN_SCREEN_ROW =
	/\bclass\s*=\s*["'][^"']{0,200}?\b(?:screen|state|step|view)[-_]?(?:switch(?:er)?|pills?|picker|nav(?:igation)?|tabs|selector)\b/i;
const DECLARES_CONFIG = /<meta\b[^>]{0,300}\bname\s*=\s*["']afb-config["']/i;
const DECLARES_SCREENS =
	/\bafb-config\b[^>]{0,3000}?(?:&quot;|")screens(?:&quot;|")\s*:\s*\[\s*\[/i;

/** Tools the page draws that the board draws around it: a colour mode switch, and a row of its own screens when none are declared. */
function ownToolsWarnings(text: string): string[] {
	const out: string[] = [];
	if (OWN_MODE_SWITCH.test(text))
		out.push(
			'The page draws its own colour mode switch. The board draws the controls around the page: declare the modes the app has in <meta name="afb-config"> (and none when the app has one), and remove the switch from the page.'
		);
	if (OWN_SCREEN_ROW.test(text) && !(DECLARES_CONFIG.test(text) && DECLARES_SCREENS.test(text)))
		out.push(
			'The page draws its own row of screens or steps over the design. Declare them in <meta name="afb-config"> (screens) so the board shows them on its own toolbar, and remove the row from the page. A step list that is part of the product itself can stay.'
		);
	return out;
}

// -- WHAT THE PAGE DECLARES AND WHETHER IT CAN REACT (AFB-20261112-2350) -- //

const META_CONTENT = /\bcontent\s*=\s*(?:'([^']*)'|"([^"]*)")/i;
/** The shape of an option key, as the board and the frame script check it. A key that is not this is never looked for in the page. */
const KEY_SHAPE = /^[a-z0-9][a-z0-9-]{0,23}$/;
/** How far before the name the tag may start, how far after it the content may reach, and how many places are tried. All bounded, so a hostile page stays fast. */
const TAG_REACH = 2_000;
const CONTENT_REACH = 12_000;
const MAX_TRIES = 20;
/** An option every page of a mockup with several screens shows is a warning from this many options on. */
const UNSCOPED_LIMIT = 3;

/** The few entities a content attribute may hold, decoded before the JSON is read. */
const decodeEntities = (v: string) =>
	v
		.replace(/&quot;|&#0*34;|&#x0*22;/gi, '"')
		.replace(/&apos;|&#0*39;|&#x0*27;/gi, "'")
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&amp;/gi, '&');

type DeclaredConfig = {
	screens: string[];
	options: { key: string; label: string; screens: unknown }[];
};

/**
 * The content of the afb-config tag and where it sits. No pattern runs over the whole page: the name is found with indexOf, the tag
 * start is the nearest opener before it, and the content is read from a short slice, so the time is bounded whatever the page holds.
 */
function configContent(text: string): { raw: string; from: number; to: number } | null {
	let at = text.indexOf('afb-config');
	for (
		let tries = 0;
		at !== -1 && tries < MAX_TRIES;
		tries++, at = text.indexOf('afb-config', at + 10)
	) {
		const start = Math.max(text.lastIndexOf('<meta', at), text.lastIndexOf('<META', at));
		if (start === -1 || at - start > TAG_REACH) continue;
		// The name must be the attribute value of this very tag
		const head = text.slice(start, at);
		if (head.includes('>') || !/\bname\s*=\s*["']$/i.test(head)) continue;
		const found = META_CONTENT.exec(text.slice(start, start + CONTENT_REACH));
		if (!found) continue;
		return {
			raw: found[1] ?? found[2] ?? '',
			from: start + found.index,
			to: start + found.index + found[0].length
		};
	}
	return null;
}

/** What the page declared in its afb-config tag, or null when it declares nothing or the content cannot be read. Never throws. */
function declaredConfig(text: string): { config: DeclaredConfig; rest: string } | null {
	try {
		const tag = configContent(text);
		if (!tag) return null;
		const parsed: unknown = JSON.parse(decodeEntities(tag.raw));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		const c = parsed as { screens?: unknown; options?: unknown };
		const pair = (p: unknown) => (Array.isArray(p) && typeof p[0] === 'string' ? p[0] : null);
		const screens = Array.isArray(c.screens)
			? c.screens.map(pair).filter((s): s is string => s !== null)
			: [];
		const options: DeclaredConfig['options'] = [];
		if (Array.isArray(c.options))
			for (const o of c.options.slice(0, 12)) {
				if (!o || typeof o !== 'object') continue;
				const r = o as { key?: unknown; label?: unknown; screens?: unknown };
				// A key the board would refuse is not looked for in the page
				if (typeof r.key !== 'string' || !KEY_SHAPE.test(r.key)) continue;
				options.push({
					key: r.key,
					label: typeof r.label === 'string' ? r.label : r.key,
					screens: r.screens
				});
			}
		// The page without its own tag content, so the tag never counts as the page reacting to itself
		return {
			config: { screens, options },
			rest: `${text.slice(0, tag.from)} ${text.slice(tag.to)}`
		};
	} catch {
		return null;
	}
}

/** True when something in the page can answer a choice: a data-<key> attribute read by a selector or a script, or a window.afbSet hook that is not only a comment. */
function pageCanReact(rest: string, key: string): boolean {
	const camel = key.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
	if (rest.includes(`data-${key}`)) return true;
	// Plain text searches, never a pattern built from the key: the key comes from the page
	if (
		rest.includes(`dataset.${camel}`) ||
		rest.includes(`dataset["${camel}"]`) ||
		rest.includes(`dataset['${camel}']`)
	)
		return true;
	return rest.split('\n').some((l) => /\bafbSet\b/.test(l) && !/^\s*(?:\/\/|\*|\/\*|<!--)/.test(l));
}

/**
 * The warnings about what the page declared: an option that names a screen the page did not declare, several options shown on every
 * screen, and a declared option or screen that nothing in the page can react to, which is how a mockup ends up with buttons that do
 * nothing. The colour mode is left to the project's kit stylesheet, which the page text does not contain.
 */
function configWarnings(text: string): string[] {
	// Its own guard: a throw here must never take the other warnings of the page with it
	try {
		return readConfigWarnings(text);
	} catch {
		return [];
	}
}

function readConfigWarnings(text: string): string[] {
	const found = declaredConfig(text);
	if (!found) return [];
	const { config, rest } = found;
	const out: string[] = [];
	const known = new Set(config.screens);
	for (const o of config.options) {
		if (!Array.isArray(o.screens)) continue;
		const unknown = o.screens.filter((s) => typeof s !== 'string' || !known.has(s));
		if (unknown.length)
			out.push(
				`The option "${clean(o.label, 32)}" lists ${plural(unknown.length, 'screen', 'screens')} the page did not declare (${unknown
					.slice(0, 3)
					.map((s) => clean(String(s), 24))
					.join(
						', '
					)}), so the board will not show that option. Use the keys from the page's own screens list.`
			);
	}
	if (config.screens.length > 1) {
		const everywhere = config.options.filter(
			(o) => !Array.isArray(o.screens) || o.screens.length === 0
		);
		if (everywhere.length >= UNSCOPED_LIMIT)
			out.push(
				`${everywhere.length} options show on every one of the ${config.screens.length} screens. Add "screens": ["key", ...] to each option so it shows only on the screens where it matters.`
			);
	}
	for (const o of config.options) {
		if (o.key === 'mode' || pageCanReact(rest, o.key)) continue;
		out.push(
			`The option "${clean(o.label, 32)}" will do nothing unless the project's kit stylesheet reads it: nothing in the page reads data-${clean(o.key, 24)} on the root element and the page defines no window.afbSet. Style the page with [data-${clean(o.key, 24)}="..."] selectors, or define window.afbSet(key, value), so the board's button changes the page.`
		);
	}
	if (config.screens.length > 1 && !pageCanReact(rest, 'screen'))
		out.push(
			'The page declares screens, but nothing reads data-screen on the root element and the page defines no window.afbSet, so the board\'s screen buttons will not change the page. Show each screen with [data-screen="..."] selectors, or define window.afbSet(key, value).'
		);
	return out;
}

/**
 * The warnings for a mockup page, in plain words. With the project's kit facts it also checks the fonts and colours against the
 * kit. An empty list means nothing was found. This never throws.
 */
export function lintMockupHtml(html: string, kit?: KitFacts | null): string[] {
	try {
		const text = shrink(html);
		const warnings: string[] = [...networkWarnings(text), ...relativeUrlWarnings(text)];
		const css = cssOf(text);
		const { embedded } = embeddedFamilies(text + css);
		const used = familiesUsed(css);
		// An icon font the kit embeds counts as embedded too, so a mockup that uses it is not told to draw vectors
		const kitIconFont = !!kit?.families.some((f) => ICON_FONT.test(f));
		const iconFonts = used.filter(
			(f) =>
				ICON_FONT.test(f) &&
				!embedded.includes(f.toLowerCase()) &&
				!kit?.families.includes(f.toLowerCase())
		);
		if (iconFonts.length)
			warnings.push(
				`The page uses the icon font ${iconFonts
					.slice(0, 3)
					.map((f) => clean(f, 60))
					.join(
						', '
					)} with no font file embedded behind it, so its icons show as empty boxes or nothing. Copy the project's icons as inline vector images (SVG), or embed the icon font file once in the kit.`
			);
		else if (ICON_CLASS.test(text) && !kitIconFont && !embedded.some((f) => ICON_FONT.test(f)))
			warnings.push(
				'The page uses icon font classes (like fa-home or material-icons) with no icon font embedded, so the icons will not show. Copy the project icons as inline vector images (SVG), or embed the icon font file once in the kit.'
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
		warnings.push(...ownToolsWarnings(text), ...configWarnings(text));
		if (kit && kit.palette.size) {
			const own = unique(coloursIn(css)).filter((c) => !kit.palette.has(c));
			if (own.length)
				warnings.push(
					`${plural(own.length, 'colour is', 'colours are')} written as a literal value that is not one of the project's colours (like ${clean(own[0], 30)}). Use the project's own classes or colour tokens instead.`
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
		const warnings: string[] = [...networkWarnings(text), ...relativeUrlWarnings(text)];
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
		const dark =
			/\[data-(?:mode|theme|bs-theme)\s*=\s*["']?dark|\.dark\b|prefers-color-scheme\s*:\s*dark|color-scheme\s*:\s*dark/i;
		if (!dark.test(text))
			warnings.push(
				'The kit defines one colour mode only. Add the dark mode (or the mode the product has), so a mockup can show both.'
			);
		const start = text.indexOf(MARKER_START);
		if (start === -1 || text.indexOf(MARKER_END) <= start)
			warnings.push(
				`The kit has no head between ${MARKER_START} and ${MARKER_END}. Put the project's stylesheet and its embedded fonts between them, so the board can add them to every mockup.`
			);
		return warnings;
	} catch {
		return [];
	}
}
