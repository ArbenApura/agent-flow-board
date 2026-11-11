// STRESS (FLOW-20261016-0935, SPEC 7). VERY LONG AND RIGHT TO LEFT TEXT MUST NOT PUSH THE PAGE SIDEWAYS ON ANY WIDTH, AND THE BOARD DRAWER MUST BE ADDRESSABLE

// -- DEP-MODULES -- //
import { expect, test } from '@playwright/test';
// -- MODULES -- //
import { signIn } from './helpers';

// -- CONSTANTS -- //

const tag = Date.now().toString(36).toUpperCase();
const LONG = 'Longtitlewithnospaces'.repeat(8);
const RTL = 'مرحبا بالعالم هذا عنوان طويل جدا من اليمين إلى اليسار لاختبار التخطيط في كل عرض';

// -- TESTS -- //

for (const width of [1440, 390]) {
	test(`M2 stress at ${width}: long and right to left titles never make the page scroll sideways`, async ({
		browser,
		baseURL
	}) => {
		const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
		const page = await ctx.newPage();
		await signIn(page, 'owner@acme.example');
		const key = `S${tag.slice(-6)}${width === 1440 ? 'D' : 'M'}`;
		const made = await page.request.post('/api/v1/orgs/acme/projects', {
			data: { key, name: `S${LONG}`.slice(0, 60) }
		});
		expect(made.ok(), await made.text()).toBe(true);
		const refs: string[] = [];
		for (const title of [LONG, RTL]) {
			const res = await page.request.post(`/api/v1/orgs/acme/projects/${key}/items`, {
				data: { title, phases: [{ key: '1', title: LONG, steps: [{ text: RTL }] }] }
			});
			expect(res.ok(), await res.text()).toBe(true);
			refs.push((await res.json()).ref);
		}
		const sideways = async (path: string) => {
			await page.goto(path);
			await expect(page.locator('h1').first()).toBeVisible();
			const over = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth
			);
			expect(over, `${path} scrolls sideways by ${over}px`).toBeLessThanOrEqual(1);
		};
		await sideways('/acme');
		await sideways(`/acme/${key}`);
		await sideways(`/acme/${key}?view=list`);
		await sideways(`/acme/${key}?view=areas`);
		for (const ref of refs) await sideways(`/acme/${key}/${ref}`);
		await sideways(`/acme/${key}/activity`);
		await ctx.close();
	});
}

test('M2 a board card opens the item page directly', async ({ browser, baseURL }) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	await page.goto('/acme/CKT');
	await page.getByTestId('item-card').first().click();
	await expect(page).toHaveURL(/\/acme\/CKT\/CKT-\d+$/);
	await ctx.close();
});

test('M2 a stale settings tab opens the first tab', async ({ browser, baseURL }) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	await page.goto('/acme/settings?tab=no-such-section');
	await expect(page.getByTestId('section-general')).toBeVisible();
	await ctx.close();
});
