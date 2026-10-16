// Behaviour of the shared overlays and controls in the gallery (Phase 2), beyond the M5 theme check.
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
	await page.goto('/dev/gallery');
	await page.waitForLoadState('networkidle');
});

test('a dialog traps focus, locks scroll, closes on Escape and returns focus', async ({ page }) => {
	const opener = page.getByRole('button', { name: 'Open dialog' });
	await opener.click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
	// Tab many times: focus never leaves the dialog
	for (let i = 0; i < 8; i++) {
		await page.keyboard.press('Tab');
		expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
	}
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
	expect(await page.evaluate(() => document.body.style.overflow)).toBe('');
	await expect(opener).toBeFocused();
});

test('a confirmation shows a busy state and refuses to close while it runs', async ({ page }) => {
	await page.getByRole('button', { name: 'Delete item' }).click();
	const dialog = page.getByRole('dialog', { name: 'Delete ACME-142?' });
	await dialog.getByRole('button', { name: 'Delete item' }).click();
	await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeVisible();
	await expect(dialog).toBeHidden({ timeout: 4000 });
});

test('a select opens with the keyboard, picks an option and cannot pick a disabled one', async ({
	page
}) => {
	const select = page.getByRole('button', { name: 'Plain select' });
	await select.focus();
	await page.keyboard.press('ArrowDown');
	const list = page.getByRole('listbox');
	await expect(list).toBeVisible();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('Enter');
	await expect(select).toContainText('In review');
	await select.click();
	await list.getByRole('option', { name: 'On hold' }).click({ force: true });
	await expect(select).toContainText('In review');
});

test('a popover closes on an outside click and on Escape', async ({ page }) => {
	await page.getByRole('button', { name: 'Filters' }).click();
	await expect(page.getByLabel('Only my items')).toBeVisible();
	await page.getByRole('heading', { name: 'Component gallery' }).click();
	await expect(page.getByLabel('Only my items')).toBeHidden();
	await page.getByRole('button', { name: 'Filters' }).click();
	await page.keyboard.press('Escape');
	await expect(page.getByLabel('Only my items')).toBeHidden();
});

test('toasts appear, a success fades and an error stays until dismissed', async ({ page }) => {
	await page.getByRole('button', { name: 'Error toast' }).click();
	const err = page.getByRole('alert').filter({ hasText: 'Could not save' });
	await expect(err).toBeVisible();
	await page.getByRole('button', { name: 'Success toast' }).click();
	// A pointer resting on a notice keeps it open, so it is moved away to let the notice fade
	await page.mouse.move(0, 0);
	const ok = page.getByRole('status').filter({ hasText: 'Saved' });
	await expect(ok).toBeVisible();
	// A notice with an Undo button stays 10 seconds so it can be used
	await expect(ok).toBeHidden({ timeout: 15000 });
	await expect(err).toBeVisible();
	await err.getByRole('button', { name: 'Dismiss' }).click();
	await expect(err).toBeHidden();
});

test('the virtual list keeps the DOM small for 5,000 rows', async ({ page }) => {
	const list = page.getByRole('list', { name: '5,000 items' });
	expect(await list.locator('[data-row]').count()).toBeLessThan(40);
	await list.evaluate((el) => (el.scrollTop = 48 * 2500));
	await expect(list.getByText('ACME-2501', { exact: true })).toBeVisible();
	expect(await list.locator('[data-row]').count()).toBeLessThan(40);
});

test('the segmented control moves with the arrow keys and the mode switch applies at once', async ({
	page
}) => {
	await page.getByRole('radio', { name: 'Light' }).first().click();
	await page.keyboard.press('ArrowRight');
	await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
});

test('a date picker picks a day', async ({ page }) => {
	await page.getByRole('button', { name: /^Due date/ }).click();
	await page.getByRole('button', { name: '20 October 2026' }).click();
	await expect(page.getByRole('button', { name: /^Due date/ })).toContainText('20 October 2026');
});

test('every tap target in the gallery is at least 44 px on a phone', async ({ browser }) => {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
	const page = await ctx.newPage();
	await page.goto('/dev/gallery');
	const small = await page.evaluate(() =>
		[...document.querySelectorAll<HTMLElement>('button, a[href], [role=switch], [role=radio]')]
			.filter((el) => el.getBoundingClientRect().width > 0)
			// A small icon button may draw small if its hit area is expanded to 44 px with a pseudo element
			.filter((el) => !el.hasAttribute('data-expanded-hit'))
			.map((el) => ({
				label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 24),
				h: Math.round(el.getBoundingClientRect().height),
				w: Math.round(el.getBoundingClientRect().width)
			}))
			.filter((m) => m.h < 44 || m.w < 44)
	);
	expect(small, JSON.stringify(small)).toEqual([]);
	await ctx.close();
});
