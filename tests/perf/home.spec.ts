import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const budgets = JSON.parse(readFileSync(resolve(import.meta.dirname, 'budgets.json'), 'utf8')) as {
	pageResponseP95Ms: number;
};

// Server-Timing on the home page stays inside the response budget, and nothing shifts while the page loads
test('home page response and layout shift stay inside the budgets', async ({ page }) => {
	const response = await page.goto('/');
	const timing = response?.headers()['server-timing'] ?? '';
	const dur = Number(/total;dur=([\d.]+)/.exec(timing)?.[1] ?? Number.NaN);
	expect(dur, 'Server-Timing header present').toBeLessThan(budgets.pageResponseP95Ms);
	const cls = await page.evaluate(
		() =>
			new Promise<number>((done) => {
				let total = 0;
				new PerformanceObserver((list) => {
					for (const e of list.getEntries() as unknown as {
						value: number;
						hadRecentInput: boolean;
					}[])
						if (!e.hadRecentInput) total += e.value;
				}).observe({ type: 'layout-shift', buffered: true });
				setTimeout(() => done(total), 500);
			})
	);
	expect(cls).toBeLessThan(0.01);
});
