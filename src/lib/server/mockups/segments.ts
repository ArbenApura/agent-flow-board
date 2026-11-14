// THE PARTS OF A MOCKUP PAGE AND WHAT IS MACHINE OUTPUT (AFB-20261114-0409, B.2 AND B.3)
// A page is cut into named parts (head, authored styles, scripts, each screen, each sheet, the shell around them) so an agent can read
// one part, ask what changed since an older version, and be held to the authored source only. Pictures, the icon sprite and
// generated CSS are machine output: they are listed as excluded ranges and never have to be read. Pure functions, no database.

// IMPORTED MODULES
import { createHash } from 'node:crypto';

// -- TYPES -- //

export type MockupSegmentKind = 'head' | 'style' | 'behavior' | 'screen' | 'surface' | 'shell';

export type MockupSegment = {
	/** Unique in a page, stable across versions: screen:today, surface:lab, behavior:1, style:1, head:1, shell:2. */
	key: string;
	kind: MockupSegmentKind;
	start: number;
	end: number;
	checksum: string;
};

export type CharRange = [number, number];

export type SegmentedMockup = {
	segments: MockupSegment[];
	/** Machine output that is never required reading: picture payloads, the icon sprite, generated style blocks. */
	excluded: CharRange[];
};

// -- CONSTANTS -- //

const MAX_SCAN = 8_000_000;
const MIN_PAYLOAD = 400;
const MIN_SPRITE = 2_000;
const BASE64_URI =
	/data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=._-]+)*;base64,([A-Za-z0-9+/=]{400,})/gi;
const SVG_URI = /data:image\/svg\+xml[;,]([^"')]{1500,})/gi;
const GENERATED_STYLE = /<style\b[^>]*\bdata-afb-generated\b[^>]*>[\s\S]*?<\/style>/gi;
const STYLE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const TEMPLATE = /<template\b[^>]*\bid\s*=\s*"([^"]{1,60})"[^>]*>[\s\S]*?<\/template>/gi;
const SCREEN_OPEN =
	/<(section|div|main|article)\b[^>]*\b(?:data-ref\s*=\s*"screen-([a-z0-9_-]{1,40})"|data-screen\s*=\s*"([a-z0-9_-]{1,40})")[^>]*>/gi;
const SPRITE_OPEN = /<svg\b[^>]*aria-hidden\s*=\s*"true"[^>]*>/gi;

// -- FUNCTIONS -- //

const sum = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/** Sorts ranges and joins the ones that touch or overlap. */
export function normalizeRanges(ranges: CharRange[]): CharRange[] {
	const sorted = ranges
		.filter(([a, b]) => b > a)
		.map(([a, b]) => [a, b] as CharRange)
		.sort((x, y) => x[0] - y[0]);
	const out: CharRange[] = [];
	for (const [a, b] of sorted) {
		const last = out[out.length - 1];
		if (last && a <= last[1]) last[1] = Math.max(last[1], b);
		else out.push([a, b]);
	}
	return out;
}

/** The parts of [start, end) that the ranges do not cover. Both lists are normalised first. */
export function subtractRanges(start: number, end: number, covered: CharRange[]): CharRange[] {
	const out: CharRange[] = [];
	let at = start;
	for (const [a, b] of normalizeRanges(covered)) {
		if (b <= at) continue;
		if (a >= end) break;
		if (a > at) out.push([at, Math.min(a, end)]);
		at = Math.max(at, b);
		if (at >= end) break;
	}
	if (at < end) out.push([at, end]);
	return out;
}

export const rangeChars = (ranges: CharRange[]) => ranges.reduce((n, [a, b]) => n + (b - a), 0);

/** Index just after the element that opens at `from` (a tag of this name), counting nested tags of the same name. */
function closeOf(html: string, tag: string, from: number): number {
	const rx = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
	rx.lastIndex = from;
	let depth = 0;
	let m: RegExpExecArray | null;
	while ((m = rx.exec(html)) !== null) {
		if (m[1]) {
			depth--;
			if (depth === 0) return m.index + m[0].length;
		} else if (!m[0].endsWith('/>')) depth++;
	}
	return html.length;
}

/** The machine output ranges of a page. */
export function excludedRanges(html: string): CharRange[] {
	const out: CharRange[] = [];
	for (const m of html.matchAll(BASE64_URI)) {
		const at = (m.index ?? 0) + m[0].length - m[1].length;
		if (m[1].length >= MIN_PAYLOAD) out.push([at, at + m[1].length]);
	}
	for (const m of html.matchAll(SVG_URI)) {
		const at = (m.index ?? 0) + m[0].length - m[1].length;
		out.push([at, at + m[1].length]);
	}
	// Generated style is machine output, unless it holds @keyframes: motion buried there would be lost, so it has to be read
	for (const m of html.matchAll(GENERATED_STYLE))
		if (!/@keyframes\b/i.test(m[0])) out.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
	// An icon sprite is one hidden svg that holds several symbols
	for (const m of html.matchAll(SPRITE_OPEN)) {
		const from = m.index ?? 0;
		const end = closeOf(html, 'svg', from);
		const body = html.slice(from, end);
		if (end - from >= MIN_SPRITE && (body.match(/<symbol\b/gi)?.length ?? 0) >= 3)
			out.push([from, end]);
	}
	return normalizeRanges(out);
}

/** Cuts a page into named parts that cover it from the first character to the last, and lists its machine output. */
export function segmentMockupHtml(html: string): SegmentedMockup {
	// A page past the scan limit is cut as far as the limit; what follows is one more shell part that has to be read
	if (html.length > MAX_SCAN) {
		const cut = segmentMockupHtml(html.slice(0, MAX_SCAN));
		cut.segments.push({
			key: 'shell:tail',
			kind: 'shell',
			start: MAX_SCAN,
			end: html.length,
			checksum: sum(html.slice(MAX_SCAN))
		});
		return cut;
	}
	const found: { kind: MockupSegmentKind; name: string | null; start: number; end: number }[] = [];
	// Only generated style that is excluded from the read is left out of the style parts (one with @keyframes is read as a style)
	const generated = [...html.matchAll(GENERATED_STYLE)]
		.filter((m) => !/@keyframes\b/i.test(m[0]))
		.map((m) => m.index ?? 0);
	for (const m of html.matchAll(STYLE)) {
		if (generated.includes(m.index ?? 0)) continue;
		found.push({
			kind: 'style',
			name: null,
			start: m.index ?? 0,
			end: (m.index ?? 0) + m[0].length
		});
	}
	for (const m of html.matchAll(SCRIPT))
		found.push({
			kind: 'behavior',
			name: null,
			start: m.index ?? 0,
			end: (m.index ?? 0) + m[0].length
		});
	for (const m of html.matchAll(TEMPLATE))
		found.push({
			kind: 'surface',
			name: m[1].replace(/^t-/, ''),
			start: m.index ?? 0,
			end: (m.index ?? 0) + m[0].length
		});
	const headEnd = (() => {
		const i = html.search(/<\/head>/i);
		return i < 0 ? 0 : i + '</head>'.length;
	})();
	for (const m of html.matchAll(SCREEN_OPEN)) {
		const start = m.index ?? 0;
		if (start < headEnd) continue;
		found.push({
			kind: 'screen',
			name: m[2] ?? m[3] ?? null,
			start,
			end: closeOf(html, m[1], start)
		});
	}
	// Outer parts win: a part inside another one (a style in a sheet, a nested screen tag) is not cut out again
	found.sort((a, b) => a.start - b.start || b.end - a.end);
	const top: typeof found = [];
	for (const f of found) {
		const last = top[top.length - 1];
		if (last && f.start < last.end) continue;
		top.push(f);
	}
	const counts = new Map<string, number>();
	const taken = new Set<string>();
	const keyOf = (kind: MockupSegmentKind, name: string | null) => {
		const base = name ? `${kind}:${name}` : kind;
		let n = counts.get(base) ?? 0;
		let key: string;
		// A repeated name gets a number, and a number that another part already holds is skipped, so every key stays unique
		do {
			n++;
			key = name ? (n === 1 ? base : `${base}-${n}`) : `${base}:${n}`;
		} while (taken.has(key));
		counts.set(base, n);
		taken.add(key);
		return key;
	};
	const segments: MockupSegment[] = [];
	let at = 0;
	const push = (kind: MockupSegmentKind, name: string | null, start: number, end: number) => {
		if (end <= start) return;
		segments.push({
			key: keyOf(kind, name),
			kind,
			start,
			end,
			checksum: sum(html.slice(start, end))
		});
	};
	const gap = (start: number, end: number) => {
		if (end <= start) return;
		// Text before the end of the head is head; the rest is the shell around the screens
		if (start < headEnd) {
			const cut = Math.min(end, headEnd);
			push('head', null, start, cut);
			if (end > cut) push('shell', null, cut, end);
		} else push('shell', null, start, end);
	};
	for (const f of top) {
		gap(at, f.start);
		push(f.kind, f.name, f.start, f.end);
		at = f.end;
	}
	gap(at, html.length);
	return { segments, excluded: excludedRanges(html) };
}

/** What changed between two cuts of a page: keys present in both with another checksum, only in the new one, only in the old one. */
export function diffSegments(
	before: MockupSegment[],
	after: MockupSegment[]
): { changed: string[]; added: string[]; removed: string[]; unchanged: string[] } {
	const old = new Map(before.map((s) => [s.key, s.checksum]));
	const now = new Map(after.map((s) => [s.key, s.checksum]));
	const changed: string[] = [];
	const added: string[] = [];
	const unchanged: string[] = [];
	for (const [k, c] of now) {
		if (!old.has(k)) added.push(k);
		else if (old.get(k) !== c) changed.push(k);
		else unchanged.push(k);
	}
	const removed = [...old.keys()].filter((k) => !now.has(k));
	return { changed, added, removed, unchanged };
}
