// M3 of FLOW-20261016-1456: at 390x664 and 1440x800, in light and dark, the auth pages never scroll sideways, and the sign up
// page shows the password strength meter as a password is typed.
import { expect, test } from '@playwright/test';

const PAGES = ['/sign-in', '/sign-up', '/reset', '/device', '/verify'];
const VIEWPORTS = [
	{ width: 390, height: 664 },
	{ width: 1440, height: 800 }
];

for (const mode of ['light', 'dark'] as const) {
	for (const viewport of VIEWPORTS) {
		test(`M3 auth pages have no sideways scroll at ${viewport.width}x${viewport.height} in ${mode}`, async ({
			page
		}) => {
			await page.setViewportSize(viewport);
			// The mode is a cookie the server reads, so the first HTML is already in the chosen mode
			await page
				.context()
				.addCookies([{ name: 'afb-mode', value: mode, url: 'http://localhost:5180' }]);
			for (const path of PAGES) {
				const res = await page.goto(path);
				// /device sends a signed out visitor to sign in, which is still an auth page with the same shell
				expect(res?.status(), path).toBeLessThan(400);
				await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
				await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
				const over = await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth
				);
				expect(over, `${path} sideways overflow`).toBeLessThanOrEqual(0);
			}
		});
	}
}

test('M3 the sign up page shows a strength meter that follows the password', async ({ page }) => {
	await page.goto('/sign-up');
	await page.getByLabel('Password').fill('short');
	await expect(page.getByTestId('password-strength')).toContainText('more characters to go');
	await page.getByLabel('Password').fill('correct horse battery staple');
	await expect(page.getByTestId('password-strength')).toContainText(/Good|Strong/);
});
