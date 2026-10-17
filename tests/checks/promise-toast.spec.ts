// M1 and M2 of FLOW-20261016-1456: an awaited action shows one toast for its whole life. A save shows a loading toast and the
// success replaces it; a refused write shows the loading toast, then an error that stays until it is dismissed.
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

const toasts = (page: import('@playwright/test').Page) => page.locator('[data-sonner-toast]');

test('M1 a save shows a loading toast, then a success toast that replaces it', async ({ page }) => {
	await signIn(page, 'owner@acme.example');
	// The run makes its own project and task, so it never touches the seeded ones
	const key = `T${Date.now().toString(36).toUpperCase().slice(-6)}`;
	expect(
		(
			await page.request.post('/api/v1/orgs/acme/projects', { data: { key, name: `Toast ${key}` } })
		).status()
	).toBe(200);
	await page.goto(`/acme/${key}/tasks`);
	// New task hands over to the agent, so the task is made through the API as the agent's tool does
	expect(
		(
			await page.request.post(`/api/v1/orgs/acme/projects/${key}/tasks`, {
				data: { title: 'Toast task' }
			})
		).status()
	).toBe(200);
	await page.reload();
	await expect(page.getByTestId('task')).toContainText('Toast task');
	await page.getByRole('button', { name: /Status of T-1/ }).click();
	// A fast request can finish before a poll looks, so every toast text that appears is recorded
	await page.evaluate(() => {
		const w = window as unknown as { __seen: string[] };
		w.__seen = [];
		new MutationObserver(() => {
			for (const t of document.querySelectorAll('[data-sonner-toast]'))
				if (t.textContent && !w.__seen.includes(t.textContent)) w.__seen.push(t.textContent);
		}).observe(document.body, { childList: true, subtree: true, characterData: true });
	});
	await page.getByRole('option', { name: 'done' }).click();
	await expect(toasts(page).filter({ hasText: 'Task updated' })).toBeVisible();
	// The loading toast is replaced by the success one, never left beside it
	await expect(toasts(page).filter({ hasText: 'Updating the task' })).toHaveCount(0);
	const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
	expect(seen.some((t) => t.includes('Updating the task'))).toBe(true);
});

test('M2 a refused write shows a loading toast, then an error that stays until dismissed', async ({
	page
}) => {
	await page.goto('/dev/gallery');
	await page.getByRole('button', { name: 'Refused promise toast' }).click();
	await expect(toasts(page).filter({ hasText: 'Saving...' })).toBeVisible();
	const err = toasts(page).filter({ hasText: 'You are not allowed to do that.' });
	await expect(err).toBeVisible();
	await page.mouse.move(0, 0);
	await page.waitForTimeout(6000);
	await expect(err).toBeVisible();
	await err.hover();
	await err.getByRole('button', { name: 'Close toast' }).click();
	await expect(err).toBeHidden();
});
