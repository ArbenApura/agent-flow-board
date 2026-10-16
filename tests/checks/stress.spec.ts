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
		await sideways(`/acme/${key}/health`);
		await ctx.close();
	});
}

test('M2 the board drawer opens from a card, has its own address, and Back closes it', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	await page.goto('/acme/CKT');
	await page.getByTestId('item-card').first().click();
	await expect(page).toHaveURL(/item=CKT-\d/);
	const peek = page.getByTestId('item-peek');
	await expect(peek).toBeVisible();
	await expect(peek.getByRole('progressbar')).toBeVisible();
	// A shared link opens the same drawer
	const link = page.url();
	await page.goto('/acme/CKT');
	await expect(page.getByTestId('item-peek')).toHaveCount(0);
	await page.goto(link);
	await expect(page.getByTestId('item-peek')).toBeVisible();
	// Escape closes it and clears the address
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('item-peek')).toHaveCount(0);
	await expect(page).not.toHaveURL(/item=/);
	// The full page is one click away
	await page.getByTestId('item-card').first().click();
	await page.getByTestId('peek-open').click();
	await expect(page).toHaveURL(/\/acme\/CKT\/CKT-\d+$/);
	await ctx.close();
});

test('M2 a stale settings tab opens the first tab, and Back closes the board drawer', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	await page.goto('/acme/settings?tab=no-such-section');
	await expect(page.getByTestId('section-general')).toBeVisible();
	await page.goto('/acme/CKT');
	await page.getByTestId('item-card').first().click();
	await expect(page.getByTestId('item-peek')).toBeVisible();
	await page.goBack();
	await expect(page.getByTestId('item-peek')).toHaveCount(0);
	await expect(page).toHaveURL(/\/acme\/CKT$/);
	// A link to an item that does not exist leaves no drawer and no stuck address
	await page.goto('/acme/CKT?item=ZZZ-9999');
	await expect(page.getByTestId('item-peek')).toHaveCount(0);
	await expect(page).not.toHaveURL(/item=/);
	await ctx.close();
});
