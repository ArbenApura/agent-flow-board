// DERIVED MOCKUP ASSETS (OUTLINE, HOOKS, TOKENS, SNAPSHOT, SHOTS) AND DESIGN-BRIEF HOOK VERIFICATION (D.1, D.2, D.3)

// IMPORTED MODULES
import { extractMockupScreensFromHtml, type NamedMockupScreen } from '../../shared/screenGlobs';
import { segmentMockupHtml, type CharRange, type MockupSegment } from './segments';

// -- TYPES -- //

export type MockupRegion = {
	tag: string;
	screen?: string;
	role?: string;
	id?: string;
	hook?: string;
};

export type MockupOutline = {
	screens: NamedMockupScreen[];
	regions: MockupRegion[];
	strings: string[];
	hooks: string[];
};

export type MockupShotAsset = {
	screen: string;
	state: string;
	width: number;
	storageKey: string;
	mime: 'image/png' | 'image/jpeg';
	size: number;
};

/** The rendered element tree of one screen, state and width, stored as a file (AFB-20261114-0409, C.2). */
export type MockupTreeAsset = {
	screen: string;
	state: string;
	width: number;
	storageKey: string;
	size: number;
	elements: number;
	/** How many grouped quality findings the tree file carries (rule R10). */
	checks?: number;
};

export type MockupDerivedAssets = {
	schema: 1;
	outline: MockupOutline;
	shots: MockupShotAsset[];
	/** Rendered trees (data-ref, role, text, box, computed styles) made by the bridge in a browser, which also sees markup built by script. */
	trees?: MockupTreeAsset[];
	tokens: string[];
	snapshot: {
		htmlLength: number;
		checksum: string;
		screenCount: number;
		regionCount: number;
		hookCount: number;
		stringCount: number;
		computedAt: string;
	};
	/** The named parts of the page (B.2). Missing on a version stored before parts existed. */
	segments?: MockupSegment[];
	/** Machine output that never has to be read (B.3): pictures, icon sprite, generated style. */
	excluded?: CharRange[];
	/** The outline lists stop at these caps; the totals say how much the page really holds. */
	totals?: { regions: number; strings: number; hooks: number };
};

// -- CONSTANTS -- //

const MAX_SCAN_HTML = 2_000_000;
const MAX_HOOKS = 400;
const MAX_REGIONS = 120;
const MAX_STRINGS = 160;
const MAX_TOKENS = 160;

// -- FUNCTIONS -- //

function decodeBasicEntities(text: string): string {
	return text
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&amp;/gi, '&')
		.replace(/\s+/g, ' ')
		.trim();
}

function countMatches(text: string, rx: RegExp): number {
	let n = 0;
	for (const _ of text.matchAll(rx)) n++;
	return n;
}

/** Extracts all inspectable hooks (`data-ref`, `data-screen`, `data-state`, `data-testid`, `id`) from mockup HTML. */
export function extractMockupHooks(rawHtml: string): string[] {
	const html = rawHtml.slice(0, MAX_SCAN_HTML);
	const hooks = new Set<string>();
	const rx =
		/\b(data-ref|data-screen|data-state|data-testid|id)\s*=\s*(?:"([^"]{1,100})"|'([^']{1,100})')/gi;
	let m: RegExpExecArray | null;
	while ((m = rx.exec(html)) !== null && hooks.size < MAX_HOOKS) {
		const attr = m[1].toLowerCase();
		const val = (m[2] ?? m[3] ?? '').trim();
		if (!val) continue;
		hooks.add(`${attr}=${val}`);
		hooks.add(val);
	}
	return [...hooks];
}

/** Extracts semantic structural regions, visible UI strings, design tokens, screens, and hooks from mockup HTML. */
export function extractMockupDerived(
	rawHtml: string,
	checksum: string,
	shots: MockupShotAsset[] = []
): MockupDerivedAssets {
	const html = rawHtml.slice(0, MAX_SCAN_HTML);
	const screens = extractMockupScreensFromHtml(html);
	const hooks = extractMockupHooks(html);

	const regions: MockupRegion[] = [];
	const regionRx = /<(header|nav|main|aside|section|footer|dialog|form|div)\b([^>]{0,600})>/gi;
	let rm: RegExpExecArray | null;
	while ((rm = regionRx.exec(html)) !== null && regions.length < MAX_REGIONS) {
		const tag = rm[1].toLowerCase();
		const attrs = rm[2] ?? '';
		const screenMatch = /\bdata-screen\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
		const roleMatch = /\brole\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
		const idMatch = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
		const refMatch = /\b(?:data-ref|data-testid)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
		const isSemantic = tag !== 'div' || Boolean(screenMatch || roleMatch || refMatch || idMatch);
		if (!isSemantic) continue;
		const region: MockupRegion = { tag };
		const scr = (screenMatch?.[1] ?? screenMatch?.[2] ?? '').trim();
		const rl = (roleMatch?.[1] ?? roleMatch?.[2] ?? '').trim();
		const idv = (idMatch?.[1] ?? idMatch?.[2] ?? '').trim();
		const hk = (refMatch?.[1] ?? refMatch?.[2] ?? '').trim();
		if (scr) region.screen = scr;
		if (rl) region.role = rl;
		if (idv) region.id = idv;
		if (hk) region.hook = hk;
		if (tag !== 'div' || scr || rl || hk || idv) regions.push(region);
	}

	// Visible text outside <script> and <style> blocks
	const stripped = html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
	const strings: string[] = [];
	const seenStrings = new Set<string>();
	const textRx = />([^<]{1,400})</g;
	let tm: RegExpExecArray | null;
	while ((tm = textRx.exec(stripped)) !== null && strings.length < MAX_STRINGS) {
		const clean = decodeBasicEntities(tm[1]);
		if (!clean || clean.length < 2) continue;
		if (/^[\d\W]+$/.test(clean) && clean.length < 2) continue;
		const clipped = clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
		if (seenStrings.has(clipped)) continue;
		seenStrings.add(clipped);
		strings.push(clipped);
	}

	const tokenSet = new Set<string>();
	const tokenRx = /(?:var\(\s*(--[a-z0-9-]+)\s*\)|^\s*(--[a-z0-9-]+)\s*:)/gim;
	let tkm: RegExpExecArray | null;
	while ((tkm = tokenRx.exec(html)) !== null && tokenSet.size < MAX_TOKENS) {
		const name = (tkm[1] ?? tkm[2] ?? '').trim();
		if (name) tokenSet.add(name);
	}
	const tokens = [...tokenSet];
	const cut = segmentMockupHtml(rawHtml);

	return {
		schema: 1,
		segments: cut.segments,
		excluded: cut.excluded,
		totals: {
			regions: countMatches(html, /<(header|nav|main|aside|section|footer|dialog|form)\b/gi),
			strings: countMatches(stripped, />[^<]{2,400}</g),
			hooks: countMatches(html, /\b(?:data-ref|data-screen|data-state|data-testid|id)\s*=\s*["']/gi)
		},
		outline: { screens, regions, strings, hooks },
		shots,
		tokens,
		snapshot: {
			htmlLength: rawHtml.length,
			checksum,
			screenCount: screens.length,
			regionCount: regions.length,
			hookCount: hooks.length,
			stringCount: strings.length,
			computedAt: new Date().toISOString()
		}
	};
}

/** Extracts cited hook identifiers from `design-brief` inventory lines and checks them against known mockup hooks. */
export function verifyDesignBriefHookCitations(
	briefBody: string,
	knownHooks: Set<string>,
	requireHookPerInventoryLine: boolean
): { missingHooks: string[]; uncitedLines: string[] } {
	const missingHooks: string[] = [];
	const uncitedLines: string[] = [];

	const lines = briefBody.split(/\r?\n/);
	let inInventory = false;
	for (const rawLine of lines) {
		const trimmed = rawLine.trim();
		if (/^#{1,6}\s+/i.test(trimmed)) {
			inInventory = /\bmockup inventory\b/i.test(trimmed);
			continue;
		}
		if (!inInventory) continue;
		const isInventoryItem = /^(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?/.test(trimmed);
		if (!isInventoryItem) continue;

		const lineHooks: string[] = [];
		const attrRx =
			/\b(data-ref|data-screen|data-state|data-testid|id)\s*=\s*(?:"([^"]{1,100})"|'([^']{1,100})')/gi;
		let m: RegExpExecArray | null;
		while ((m = attrRx.exec(trimmed)) !== null) {
			const attr = m[1].toLowerCase();
			const val = (m[2] ?? m[3] ?? '').trim();
			if (val) lineHooks.push(`${attr}=${val}`);
		}
		const hookTagRx = /\bhook\s*:\s*`?([A-Za-z0-9_.:=-]{1,100})`?/gi;
		while ((m = hookTagRx.exec(trimmed)) !== null) {
			const val = m[1].trim();
			if (val) lineHooks.push(val);
		}
		if (requireHookPerInventoryLine && !lineHooks.length) {
			uncitedLines.push(trimmed.slice(0, 120));
		}
		for (const hk of lineHooks) {
			const normalized = hk.replace(/^['"]|['"]$/g, '');
			if (!knownHooks.has(normalized) && !knownHooks.has(normalized.toLowerCase())) {
				missingHooks.push(normalized);
			}
		}
	}

	return {
		missingHooks: [...new Set(missingHooks)],
		uncitedLines
	};
}
