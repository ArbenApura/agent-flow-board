// LEGIBILITY MEASURE (FLOW-20261016-0935). COUNTS TEXT UNDER 13 PX (BADGES AND COUNTS EXEMPT) AND CONTRAST FAILURES ON EVERY SCREEN, DARK AND LIGHT AT 1440. RUN: node tests/ui-shots/measure.mjs
// The same numbers as tests/checks/legibility.spec.ts, printed as a table for the before and after of a redesign
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('@playwright/test');
const BASE = process.env.AFB_BASE_URL ?? 'http://localhost:5180';
const routes = [
	'/sign-in',
	'/',
	'/acme',
	'/acme/CKT',
	'/acme/CKT/CKT-1',
	'/acme/CKT/tasks',
	'/acme/CKT/activity',
	'/acme/search?q=promo',
	'/acme/CKT/publish',
	'/acme/CKT/health',
	'/settings',
	'/acme/settings',
	'/acme/CKT/settings',
	'/acme/CKT/ui'
];
const browser = await chromium.launch();
const res = {};
for (const mode of ['dark', 'light']) {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	await ctx.addCookies([{ name: 'afb-mode', value: mode, url: BASE }]);
	await ctx.request.post(BASE + '/api/auth/sign-in/email', {
		headers: { origin: BASE, 'content-type': 'application/json' },
		data: { email: 'owner@acme.example', password: 'seed-password-for-previews' }
	});
	const page = await ctx.newPage();
	for (const r of routes) {
		await page.goto(BASE + r, { waitUntil: 'load' });
		await page.waitForTimeout(500);
		const m = await page.evaluate(() => {
			const parse = (c) => {
				const m = c.match(/rgba?\(([^)]+)\)/);
				if (!m) return null;
				const p = m[1].split(/[ ,/]+/).map(Number);
				return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
			};
			const lum = ({ r, g, b }) => {
				const f = (v) => {
					v /= 255;
					return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
				};
				return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
			};
			const bgOf = (el) => {
				let e = el;
				while (e) {
					const c = parse(getComputedStyle(e).backgroundColor);
					if (c && c.a > 0.95) return c;
					e = e.parentElement;
				}
				return { r: 255, g: 255, b: 255, a: 1 };
			};
			let total = 0,
				small = 0,
				low = 0;
			const sizes = {};
			const lows = [];
			const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
			while (w.nextNode()) {
				const n = w.currentNode;
				if (!n.nodeValue.trim()) continue;
				const el = n.parentElement;
				if (!el || el.closest('script,style')) continue;
				const cs = getComputedStyle(el);
				if (cs.visibility === 'hidden' || cs.display === 'none') continue;
				const rect = el.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) continue;
				total++;
				const fs = Math.round(parseFloat(cs.fontSize));
				sizes[fs] = (sizes[fs] || 0) + 1;
				if (fs < 13 && !el.closest('[data-badge],[data-count]')) small++;
				const fg = parse(cs.color),
					bg = bgOf(el);
				if (!fg) continue;
				const a = fg.a;
				const mix = {
					r: fg.r * a + bg.r * (1 - a),
					g: fg.g * a + bg.g * (1 - a),
					b: fg.b * a + bg.b * (1 - a)
				};
				const L1 = lum(mix),
					L2 = lum(bg);
				const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
				const large = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight) >= 700);
				if (ratio < (large ? 3 : 4.5)) {
					low++;
					if (lows.length < 3)
						lows.push(`${n.nodeValue.trim().slice(0, 24)} ${ratio.toFixed(1)}:1 ${fs}px`);
				}
			}
			return { total, small, low, sizes, lows };
		});
		res[mode + ' ' + r] = m;
	}
	await ctx.close();
}
await browser.close();
for (const [k, v] of Object.entries(res)) {
	console.log(
		k.padEnd(34),
		'text',
		String(v.total).padStart(3),
		'<13px',
		String(v.small).padStart(3),
		'low-contrast',
		String(v.low).padStart(3),
		'sizes',
		Object.keys(v.sizes)
			.sort((a, b) => a - b)
			.join('/'),
		v.lows.length ? '| ' + v.lows.join('; ') : ''
	);
}
