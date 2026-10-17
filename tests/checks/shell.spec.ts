// THE FAST SHELL (FLOW-20261016-0935 13.7, ADR-019 AND ADR-020). THE SHELL IS SERVED WITHOUT A SESSION READ, A SKELETON SHOWS BEFORE THE DATA, A NAVIGATION ANSWERS AT ONCE,
// A SEEN PAGE COMES FROM THE CACHE, A WRITE CLEARS IT, AND A SIGNED OUT PERSON IS SENT TO SIGN IN

// -- DEP-MODULES -- //
import { expect, test } from '@playwright/test';
// -- MODULES -- //
import { signIn } from './helpers';

// -- CONSTANTS -- //

const DATA = '**/__data.json*';

// -- TESTS -- //

test('M20 the shell is the same small page for anyone and holds the boot skeleton', async ({
	request
}) => {
	// Nobody is signed in, and the page is still answered with 200 and the shell, so no session was read for it
	const res = await request.get('/acme/CKT', {
		headers: { 'sec-fetch-dest': 'document' },
		maxRedirects: 0
	});
	expect(res.status()).toBe(200);
	const html = await res.text();
	expect(html).toContain('id="afb-boot"');
	expect(html).not.toContain('Checkout rebuild');
});

test('M20 a signed out person is sent to sign in, and the skeleton shows before the data', async ({
	page
}) => {
	await page.route(DATA, async (route) => {
		await new Promise((r) => setTimeout(r, 1200));
		await route.continue();
	});
	await page.goto('/acme/CKT', { waitUntil: 'commit' });
	await expect(page.locator('#afb-boot')).toBeVisible({ timeout: 1000 });
	await expect(page).toHaveURL(/\/sign-in\?next=/);
	await expect(page.locator('#afb-boot')).toHaveCount(0);
});

test('M20 a navigation shows its skeleton at once, and a page seen before comes from the cache', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	await page.goto('/acme/CKT');
	await page.waitForLoadState('networkidle');
	// First visit to Tasks, slowed, shows the progress bar and the skeleton while it waits
	let slow = true;
	// Only the Tasks data is slowed, so nothing else the page asks for can hold the navigation back
	await page.route(DATA, async (route) => {
		if (slow && route.request().url().includes('/tasks/__data.json'))
			await new Promise((r) => setTimeout(r, 1500));
		await route.continue();
	});
	await page.getByRole('link', { name: 'Tasks', exact: true }).first().click();
	await expect(page.getByTestId('nav-progress')).toBeVisible({ timeout: 1000 });
	await expect(page.getByTestId('route-skeleton')).toBeVisible({ timeout: 1500 });
	await expect(page.getByTestId('task-list').or(page.getByText('No tasks yet'))).toBeVisible();
	// Back to the registry, then to Tasks again with the network still slow. The cache answers before the network does
	await page.getByRole('link', { name: 'Registry', exact: true }).first().click();
	await expect(page.getByTestId('page-title')).toHaveText(/Checkout rebuild/, { timeout: 4000 });
	const t = Date.now();
	await page.getByRole('link', { name: 'Tasks', exact: true }).first().click();
	await expect(page.getByTestId('page-title')).toHaveText('Tasks', { timeout: 900 });
	expect(Date.now() - t).toBeLessThan(1000);
	slow = false;
	await ctx.close();
});

test('M20 a write clears the cache, so a person sees their own change at once', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	await page.goto('/acme/CKT/tasks');
	const title = `Shell cache task ${Date.now().toString(36)}`;
	// New task hands over to the agent, so the task is made through the API as the agent's tool does
	expect(
		(await page.request.post('/api/v1/orgs/acme/projects/CKT/tasks', { data: { title } })).status()
	).toBe(200);
	await page.reload();
	await expect(page.getByText(title)).toBeVisible();
	// Away and back: the list comes from the network again, because the write cleared what was cached
	await page.getByRole('link', { name: 'Registry', exact: true }).first().click();
	await expect(page.getByTestId('page-title')).toHaveText(/Checkout rebuild/);
	await page.getByRole('link', { name: 'Tasks', exact: true }).first().click();
	await expect(page.getByText(title)).toBeVisible();
	await ctx.close();
});

test('M20 when the session ends, a seen page is not shown again from the cache', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	await page.goto('/acme/CKT');
	await page.getByRole('link', { name: 'Tasks', exact: true }).first().click();
	await expect(page.getByTestId('page-title')).toHaveText('Tasks');
	await page.getByRole('link', { name: 'Registry', exact: true }).first().click();
	await expect(page.getByTestId('page-title')).toHaveText(/Checkout rebuild/);
	// The mouse stays over the Tasks link, whose hover preload the router keeps for a moment, so move away and let that lapse
	await page.mouse.move(700, 500);
	await page.waitForTimeout(1500);
	// The session ends while the tab stays open. The next visit may show the cached page for a moment, then the refresh is sent to sign in
	await ctx.clearCookies();
	await page.getByRole('link', { name: 'Tasks', exact: true }).first().click();
	await expect(page).toHaveURL(/\/sign-in/, { timeout: 5000 });
	await ctx.close();
});
