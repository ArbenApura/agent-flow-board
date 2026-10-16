// OVERLAYS (FLOW-20261016-0935, ADR-010). ESCAPE CLOSES ONLY THE TOPMOST LAYER, FOCUS MOVES IN AND RETURNS, A DIALOG TRAPS TAB, AND A PHONE GETS A SHEET

// -- DEP-MODULES -- //
import { expect, test } from '@playwright/test';
// -- MODULES -- //
import { signIn } from './helpers';

// -- TESTS -- //

test('M2 overlays: a popover closes on Escape and gives focus back to its button', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	await page.goto('/acme/CKT');
	const button = page.getByTestId('filters-button');
	await button.click();
	await expect(page.getByRole('checkbox', { name: /^planned/ })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(page.getByRole('checkbox', { name: /^planned/ })).toHaveCount(0);
	await expect(button).toBeFocused();
	await ctx.close();
});

test('M2 overlays: a drawer opens on a button, traps Tab, closes on Escape and returns focus', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	await page.goto('/acme/CKT/CKT-1');
	const opener = page.getByTestId('review-commits');
	await opener.click();
	const drawer = page.getByRole('dialog', { name: 'Commits with no recorded step' });
	await expect(drawer).toBeVisible();
	// A drawer is a right hand panel on a wide screen
	const box = await drawer.boundingBox();
	expect(box!.x).toBeGreaterThan(1440 - 640);
	expect(box!.height).toBeGreaterThan(800);
	// Tab never leaves the dialog
	for (let i = 0; i < 6; i++) {
		await page.keyboard.press('Tab');
		expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
	}
	// The page behind does not scroll while it is open
	expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).toBe('hidden');
	await page.keyboard.press('Escape');
	await expect(drawer).toHaveCount(0);
	await expect(opener).toBeFocused();
	await ctx.close();
});

test('M2 overlays: a dialog is a bottom sheet on a phone and a centred panel on a desktop', async ({
	browser,
	baseURL
}) => {
	for (const [width, height] of [
		[390, 844],
		[1440, 900]
	]) {
		const ctx = await browser.newContext({ baseURL, viewport: { width, height } });
		const page = await ctx.newPage();
		await signIn(page, 'owner@acme.example');
		await page.goto('/acme/CKT');
		await page.getByTestId('new-item').click();
		const dialog = page.getByRole('dialog', { name: 'New item' });
		await expect(dialog).toBeVisible();
		await expect.poll(async () => (await dialog.boundingBox())?.y ?? 0).toBeGreaterThan(0);
		const box = (await dialog.boundingBox())!;
		if (width === 390) {
			// The sheet sits on the bottom edge and spans the width
			// The sheet slides in, so wait for it to settle on the bottom edge
			await expect
				.poll(async () => {
					const b = (await dialog.boundingBox())!;
					return Math.round(b.y + b.height);
				})
				.toBe(height);
			expect(box.width).toBeGreaterThanOrEqual(width - 2);
		} else {
			// The dialog is centred
			expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(2);
		}
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await ctx.close();
	}
});
