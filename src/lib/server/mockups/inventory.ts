// THE INVENTORY OF A MOCKUP, SEEDED FROM ITS SOURCE (AFB-20261114-0409, D.6)
// A build lists everything the mockup shows before it builds, then marks each line built, free or differs. Writing hundreds of lines by
// hand is slow and misses things, so the lines come from the source: the regions with a hook, the texts, the states, what opens what, and
// every transition and animation (in the authored CSS and in utility classes) with its trigger, property, duration and easing. The
// agent reads the source and marks the lines; this only makes sure nothing the source says is left off. Pure functions.

// -- TYPES -- //
import type { MockupSegment } from './segments';

export type InventoryCounts = {
	regions: number;
	texts: number;
	states: number;
	interactions: number;
	motion: number;
};

export type Inventory = {
	lines: string[];
	counts: InventoryCounts;
	/** True when a list stopped at its limit; ask again for fewer screens. */
	truncated: boolean;
};

// -- CONSTANTS -- //

const LIMITS = { regions: 150, texts: 200, states: 40, interactions: 120, motion: 120 };

// -- FUNCTIONS -- //

const clip = (s: string, n = 100) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const decode = (s: string) =>
	s
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&amp;/gi, '&')
		.replace(/\s+/g, ' ')
		.trim();

/** The nearest data-ref at or above a position, so a line can say where it is. */
function refAt(html: string, pos: number): string {
	const before = html.slice(Math.max(0, pos - 4000), pos);
	const all = [...before.matchAll(/\bdata-ref\s*=\s*["']([^"']{1,100})["']/gi)];
	return all.length ? all[all.length - 1][1] : '';
}

/** The motion in a piece of CSS: every rule that sets a transition or an animation, the keyframes, and the reduced-motion rule. */
export function motionInCss(css: string): string[] {
	const text = css.replace(/<\/?style\b[^>]*>/gi, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
	const out: string[] = [];
	for (const m of text.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)\s*\{/g))
		out.push(`motion keyframes ${m[1]}`);
	if (/@media[^{]*prefers-reduced-motion/i.test(text))
		out.push('motion reduced-motion rule present');
	for (const m of text.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
		const selector = decode(m[1]).replace(/^\}/, '').trim();
		const body = m[2];
		const t = /(?:^|;)\s*transition\s*:\s*([^;]+)/i.exec(body);
		const td = /(?:^|;)\s*transition-duration\s*:\s*([^;]+)/i.exec(body);
		const a = /(?:^|;)\s*animation\s*:\s*([^;]+)/i.exec(body);
		const an = /(?:^|;)\s*animation-name\s*:\s*([^;]+)/i.exec(body);
		if (t) out.push(`motion css ${clip(selector, 70)}: transition ${clip(decode(t[1]), 90)}`);
		else if (td) out.push(`motion css ${clip(selector, 70)}: transition-duration ${decode(td[1])}`);
		if (a) out.push(`motion css ${clip(selector, 70)}: animation ${clip(decode(a[1]), 90)}`);
		else if (an) out.push(`motion css ${clip(selector, 70)}: animation-name ${decode(an[1])}`);
	}
	return [...new Set(out)];
}

/** The motion utilities on each element of a piece of markup, with the data-ref that holds them. */
export function motionInClasses(html: string): string[] {
	const out: string[] = [];
	const rx = /<([a-z][a-z0-9-]*)\b([^>]*\bclass\s*=\s*"([^"]*)"[^>]*)>/gi;
	let m: RegExpExecArray | null;
	while ((m = rx.exec(html)) !== null) {
		const used = m[3]
			.split(/\s+/)
			.filter((c) =>
				/^(?:[a-z-]+:)*(transition(?:-[a-z]+)?|duration-\S+|ease-\S+|delay-\S+|animate-\S+|motion-(?:reduce|safe):\S+)$/.test(
					c
				)
			);
		if (!used.length) continue;
		// The element's own hook first, else the nearest one above it
		const ref = /\bdata-ref\s*=\s*["']([^"']{1,100})["']/i.exec(m[2])?.[1] ?? refAt(html, m.index);
		out.push(`motion class ${ref ? `in ${ref}` : `on <${m[1]}>`}: ${used.join(' ')}`);
	}
	return [...new Set(out)];
}

/** Everything a piece of markup shows: regions, texts, states and what opens what. */
export function inventoryOfMarkup(
	html: string
): Omit<Inventory, 'counts'> & { counts: InventoryCounts } {
	const lines: string[] = [];
	let truncated = false;
	const counts: InventoryCounts = { regions: 0, texts: 0, states: 0, interactions: 0, motion: 0 };
	const take = (kind: keyof InventoryCounts, line: string) => {
		if (counts[kind] >= LIMITS[kind]) {
			truncated = true;
			return;
		}
		counts[kind]++;
		lines.push(`- [ ] ${line}`);
	};
	const noScript = html
		.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
	for (const m of noScript.matchAll(
		/<([a-z][a-z0-9-]*)\b[^>]*\bdata-ref\s*=\s*["']([^"']{1,100})["'][^>]*>/gi
	))
		take('regions', `region data-ref=${m[2]} <${m[1].toLowerCase()}>`);
	const seen = new Set<string>();
	for (const m of noScript.matchAll(/>([^<]{2,400})</g)) {
		const t = clip(decode(m[1]));
		if (t.length < 2 || /^[\d\W]+$/.test(t) || seen.has(t)) continue;
		seen.add(t);
		take('texts', `text "${t}"`);
	}
	const states = new Set<string>();
	for (const m of noScript.matchAll(/\bdata-state\s*=\s*["']([a-z0-9_-]{1,40})["']/gi))
		states.add(m[1].toLowerCase());
	for (const s of states) take('states', `state ${s}`);
	for (const m of noScript.matchAll(
		/<([a-z][a-z0-9-]*)\b([^>]*)\bdata-open\s*=\s*["']([^"']{1,60})["']([^>]*)>([^<]{0,80})/gi
	)) {
		const label =
			decode(`${m[5]}`) || (/aria-label\s*=\s*["']([^"']+)/i.exec(m[2] + m[4])?.[1] ?? '');
		take(
			'interactions',
			`interaction ${label ? `"${clip(label, 50)}" ` : ''}opens surface:${m[3].replace(/^t-/, '')}`
		);
	}
	for (const m of noScript.matchAll(/<(button|a)\b([^>]*)>([^<]{1,60})</gi)) {
		const attrs = m[2];
		if (/\bdata-open\s*=/.test(attrs)) continue;
		const ref = /\bdata-ref\s*=\s*["']([^"']+)/i.exec(attrs)?.[1];
		const label = decode(m[3]) || /aria-label\s*=\s*["']([^"']+)/i.exec(attrs)?.[1] || '';
		if (label)
			take(
				'interactions',
				`interaction control "${clip(label, 50)}"${ref ? ` data-ref=${ref}` : ''}`
			);
	}
	return { lines, counts, truncated };
}

/** What the scripts of a page do: the events they listen to and the classes they toggle, as pointers for reading them. */
export function behaviourPointers(scripts: string): string[] {
	const events = [
		...new Set([...scripts.matchAll(/addEventListener\(\s*['"]([a-z:-]+)['"]/gi)].map((m) => m[1]))
	];
	const classes = [
		...new Set(
			[...scripts.matchAll(/classList\.(?:add|toggle)\(\s*['"]([A-Za-z0-9_-]+)['"]/g)].map(
				(m) => m[1]
			)
		)
	];
	const timers = [
		...new Set(
			[...scripts.matchAll(/setTimeout\([^;]*?,\s*(\d{2,5})\s*\)/g)].map((m) => `${m[1]} ms`)
		)
	];
	const out: string[] = [];
	if (events.length) out.push(`behavior listens to: ${events.join(', ')}`);
	if (classes.length) out.push(`behavior toggles classes: ${classes.slice(0, 30).join(', ')}`);
	if (timers.length) out.push(`behavior timers: ${timers.slice(0, 20).join(', ')}`);
	if (/afbSet/.test(scripts)) out.push('behavior answers window.afbSet (the viewer controls)');
	return out;
}

/**
 * The seeded inventory of the parts asked for. `html` is the whole page and `segments` its parts; `scopes` are part keys
 * ("screen:today", "surface:lab") or bare screen names ("today"). The authored styles and scripts are always included, since motion and
 * behaviour are shared across screens.
 */
export function seedInventory(
	html: string,
	segments: MockupSegment[],
	scopes: string[]
): Inventory & { scopes: string[]; unknown: string[] } {
	const wanted = scopes.map((s) => (s.includes(':') ? s : `screen:${s}`));
	const unknown = wanted.filter((k) => !segments.some((s) => s.key === k));
	const chosen = segments.filter((s) => wanted.includes(s.key));
	const markup = chosen.map((s) => html.slice(s.start, s.end)).join('\n');
	const base = inventoryOfMarkup(markup);
	const lines = [...base.lines];
	const counts = { ...base.counts };
	let truncated = base.truncated;
	const motion = [
		...segments
			.filter((s) => s.kind === 'style')
			.flatMap((s) => motionInCss(html.slice(s.start, s.end))),
		...motionInClasses(markup)
	];
	for (const m of motion) {
		if (counts.motion >= LIMITS.motion) {
			truncated = true;
			break;
		}
		counts.motion++;
		lines.push(`- [ ] ${m}`);
	}
	const scripts = segments
		.filter((s) => s.kind === 'behavior')
		.map((s) => html.slice(s.start, s.end))
		.join('\n');
	for (const p of behaviourPointers(scripts)) lines.push(`- [ ] ${p}`);
	return { lines, counts, truncated, scopes: chosen.map((s) => s.key), unknown };
}
