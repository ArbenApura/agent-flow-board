// LEGIBILITY (FLOW-20261016-0935, SPEC 2.1 AND 7). NO TEXT UNDER 13 PX EXCEPT BADGES AND COUNTS, AND NO TEXT THAT FAILS ITS CONTRAST, ON EVERY SCREEN
// IN LIGHT AND DARK, AT 1440 AND 390 WIDE

// -- DEP-MODULES -- //
import { expect, test } from '@playwright/test';
// -- MODULES -- //
import { signIn } from './helpers';

// -- CONSTANTS -- //

const SCREENS = [
	'/',
	'/acme',
	'/acme/CKT',
	'/acme/CKT?view=list',
	'/acme/CKT/CKT-1',
	'/acme/CKT/CKT-1?tab=decisions',
	'/acme/CKT/CKT-1?tab=docs',
	'/acme/CKT/CKT-1?tab=checks',
	'/acme/CKT/CKT-1?tab=ui',
	'/acme/CKT/CKT-1?tab=files',
	'/acme/CKT/CKT-1?tab=activity',
	'/acme/CKT/CKT-1?tab=discussion',
	'/acme/CKT/trash',
	'/connect',
	'/acme/CKT/tasks',
	'/acme/CKT/activity',
	'/acme/search?q=promo',
	'/settings',
	'/acme/settings',
	'/acme/CKT/settings',
	'/acme/CKT/ui'
];
const MIN_PX = 13;
/** A screen may carry this many exempt badges and counts, so the exemption cannot be used to hide body text. */
const MAX_EXEMPT = 40;

// -- FUNCTIONS -- //

type Offender = { text: string; why: string };
type Result = { offenders: Offender[]; exempt: number };

function measure(min: number): Result {
	const parse = (c: string) => {
		const m = c.match(/rgba?\(([^)]+)\)/);
		if (!m) return null;
		const p = m[1].split(/[ ,/]+/).map(Number);
		return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
	};
	const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
		const f = (v: number) => {
			v /= 255;
			return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
		};
		return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
	};
	const bgOf = (el: Element | null) => {
		let e = el;
		while (e) {
			const c = parse(getComputedStyle(e).backgroundColor);
			if (c && c.a > 0.95) return c;
			e = e.parentElement;
		}
		return { r: 255, g: 255, b: 255, a: 1 };
	};
	const offenders: Offender[] = [];
	let exempt = 0;
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) {
		const node = walker.currentNode;
		const text = (node.nodeValue ?? '').trim();
		const el = node.parentElement;
		if (!text || !el || el.closest('script,style,svg')) continue;
		const cs = getComputedStyle(el);
		const box = el.getBoundingClientRect();
		if (cs.visibility === 'hidden' || cs.display === 'none' || box.width === 0 || box.height === 0)
			continue;
		const size = parseFloat(cs.fontSize);
		const isExempt = !!el.closest('[data-badge],[data-count]');
		if (size < min - 0.01) {
			if (isExempt) exempt++;
			else offenders.push({ text: text.slice(0, 40), why: `${size}px` });
		}
		const fg = parse(cs.color);
		const bg = bgOf(el);
		if (!fg) continue;
		const mix = {
			r: fg.r * fg.a + bg.r * (1 - fg.a),
			g: fg.g * fg.a + bg.g * (1 - fg.a),
			b: fg.b * fg.a + bg.b * (1 - fg.a)
		};
		const l1 = lum(mix);
		const l2 = lum(bg);
		const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
		const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight) >= 700);
		if (ratio < (large ? 3 : 4.5))
			offenders.push({ text: text.slice(0, 40), why: `contrast ${ratio.toFixed(1)}:1` });
	}
	return { offenders, exempt };
}

// -- TESTS -- //

for (const mode of ['light', 'dark'] as const) {
	for (const [width, height] of [
		[1440, 900],
		[390, 844]
	]) {
		test(`M2 legibility, ${mode} at ${width}: nothing under ${MIN_PX} px except badges and counts, and no contrast failure`, async ({
			browser,
			baseURL
		}) => {
			const ctx = await browser.newContext({ baseURL, viewport: { width, height } });
			await ctx.addCookies([{ name: 'afb-mode', value: mode, url: baseURL! }]);
			const page = await ctx.newPage();
			await signIn(page, 'owner@acme.example');
			const failures: string[] = [];
			for (const path of SCREENS) {
				await page.goto(path);
				await expect(page.locator('h1').first()).toBeVisible();
				const r = await page.evaluate(measure, MIN_PX);
				if (r.exempt > MAX_EXEMPT) failures.push(`${path}: ${r.exempt} exempt items`);
				for (const o of r.offenders) failures.push(`${path}: "${o.text}" ${o.why}`);
			}
			expect(failures, failures.join('\n')).toEqual([]);
			await ctx.close();
		});
	}
}
