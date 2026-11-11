// SHELL MEASUREMENT (FLOW-20261016-0935 STEP 10.1): FIRST PAINT, LARGEST PAINT, A NAVIGATION AND THE DATA REQUEST TIMES, ON A THROTTLED PROFILE
// USAGE: node tests/perf/measure.mjs [--base http://localhost:5188] [--runs 3]
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (n, f) => (args.includes(n) ? args[args.indexOf(n) + 1] : f);
const base = opt('--base', 'http://localhost:5188');
const runs = Number(opt('--runs', 3));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const browser = await chromium.launch();
const results = { signIn: [], board: [], item: [], nav: [], requests: [] };
for (let i = 0; i < runs; i++) {
	const ctx = await browser.newContext({ baseURL: base });
	const page = await ctx.newPage();
	const cdp = await ctx.newCDPSession(page);
	// FAST 4G AND A 4X SLOWER CPU
	await cdp.send('Network.enable');
	await cdp.send('Network.emulateNetworkConditions', {
		offline: false,
		latency: 40,
		downloadThroughput: (9 * 1024 * 1024) / 8,
		uploadThroughput: (1.5 * 1024 * 1024) / 8
	});
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
	const paint = async () =>
		page.evaluate(
			() =>
				new Promise((done) => {
					const out = { fcp: 0, lcp: 0 };
					for (const e of performance.getEntriesByType('paint'))
						if (e.name === 'first-contentful-paint') out.fcp = e.startTime;
					new PerformanceObserver((l) => {
						for (const e of l.getEntries()) out.lcp = e.startTime;
					}).observe({ type: 'largest-contentful-paint', buffered: true });
					setTimeout(() => done(out), 800);
				})
		);
	await page.goto('/sign-in');
	results.signIn.push(await paint());
	await page.getByLabel('Email').fill('owner@acme.example');
	await page.getByLabel('Password').fill('seed-password-for-previews');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.getByRole('heading', { name: 'Your organisations' }).waitFor();
	const reqs = [];
	page.on('requestfinished', async (r) => {
		const t = r.timing();
		if (/\/(api|__data)|\.json/.test(r.url()))
			reqs.push({ url: new URL(r.url()).pathname, ms: t.responseEnd });
	});
	let t = Date.now();
	await page.goto('/acme');
	await page.locator('main').waitFor();
	results.board.push({ ...(await paint()), total: Date.now() - t });
	const hrefs = await page
		.locator('a[href^="/acme/"]')
		.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
	const project = hrefs.find((h) => /^\/acme\/[\w-]+$/.test(h) && !/\/(search|settings)$/.test(h));
	await page.goto(project);
	await page.locator('h1').first().waitFor();
	const items = await page
		.locator(`a[href^="${project}/"]`)
		.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
	const href = items.find((h) => !/\/(tasks|activity|settings|trash|ui)$/.test(h));
	const link = page.locator(`a[href="${href}"]`).first();
	t = Date.now();
	await link.click();
	await page.getByRole('dialog').waitFor();
	await page.locator('h1').first().waitFor();
	results.nav.push(Date.now() - t);
	t = Date.now();
	await page.goto(href);
	await page.locator('h1').first().waitFor();
	results.item.push({ ...(await paint()), total: Date.now() - t });
	results.requests.push(...reqs);
	await ctx.close();
}
await browser.close();
const m = (xs, k) => Math.round(median(xs.map((x) => x[k])));
console.table([
	{ screen: 'sign in (cold)', fcp: m(results.signIn, 'fcp'), lcp: m(results.signIn, 'lcp') },
	{
		screen: 'project (cold)',
		fcp: m(results.board, 'fcp'),
		lcp: m(results.board, 'lcp'),
		ready: m(results.board, 'total')
	},
	{
		screen: 'item (cold)',
		fcp: m(results.item, 'fcp'),
		lcp: m(results.item, 'lcp'),
		ready: m(results.item, 'total')
	},
	{ screen: 'open the quick look from the board', ready: Math.round(median(results.nav)) }
]);
const byUrl = {};
for (const r of results.requests) (byUrl[r.url] ??= []).push(r.ms);
console.table(
	Object.entries(byUrl).map(([url, xs]) => ({
		url,
		n: xs.length,
		medianMs: Math.round(median(xs))
	}))
);
