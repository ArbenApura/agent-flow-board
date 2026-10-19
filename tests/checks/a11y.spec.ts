// ACCESSIBILITY (FLOW-20261016-0935, SPEC 7). EVERY CONTROL HAS A NAME, EVERY RING AND BAR HAS A VALUE AS TEXT, AND THE KEYBOARD REACHES WHAT MOVED INTO A POPOVER

// -- DEP-MODULES -- //
import { expect, test } from '@playwright/test';
// -- MODULES -- //
import { signIn } from './helpers';

// -- CONSTANTS -- //

const SCREENS = [
	'/',
	'/acme',
	'/acme/CKT',
	'/acme/CKT?view=list',
	'/acme/CKT/CKT-1',
	'/acme/CKT/tasks',
	'/acme/CKT/activity',
	'/acme/search?q=promo',
	'/acme/CKT/health',
	'/settings',
	'/acme/settings',
	'/acme/CKT/settings',
	'/acme/CKT/ui'
];

// -- FUNCTIONS -- //

/** Controls with no accessible name, and progress graphics with no value, as short descriptions. */
function audit(): string[] {
	const out: string[] = [];
	const shown = (el: Element) => {
		const box = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		return box.width > 0 && box.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
	};
	const label = (el: Element) => {
		const direct = (el.getAttribute('aria-label') ?? '').trim();
		if (direct) return direct;
		const by = el.getAttribute('aria-labelledby');
		if (by && by.split(' ').some((id) => (document.getElementById(id)?.textContent ?? '').trim()))
			return 'x';
		const inputs = (el as HTMLInputElement).labels;
		if (inputs && inputs.length && [...inputs].some((l) => (l.textContent ?? '').trim()))
			return 'x';
		return (el.textContent ?? '').trim() || (el.getAttribute('title') ?? '').trim();
	};
	const controls = document.querySelectorAll(
		'button, a[href], [role=button], [role=switch], [role=checkbox], [role=radio], [role=tab], input:not([type=hidden]), select, textarea'
	);
	for (const el of controls) {
		if (!shown(el)) continue;
		if (!label(el)) out.push(`no name: <${el.tagName.toLowerCase()}> ${el.outerHTML.slice(0, 90)}`);
	}
	for (const el of document.querySelectorAll('[role=progressbar]')) {
		if (!shown(el)) continue;
		if (el.getAttribute('aria-valuenow') === null || !(el.getAttribute('aria-label') ?? '').trim())
			out.push(`progress without a value or a name: ${el.outerHTML.slice(0, 90)}`);
	}
	return out;
}

// -- TESTS -- //

test('M2 accessibility: every control has a name and every progress graphic has a value, on every screen', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	const failures: string[] = [];
	for (const path of SCREENS) {
		await page.goto(path);
		await expect(page.locator('h1').first()).toBeVisible();
		for (const f of await page.evaluate(audit)) failures.push(`${path}: ${f}`);
	}
	expect(failures, failures.join('\n')).toEqual([]);
	await ctx.close();
});

test('M2 accessibility: the keyboard reaches the filters, the account menu and the settings tabs, and focus is visible', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	await page.goto('/acme/CKT');
	// Tab until the Filters button has focus, then open it with the keyboard
	const filters = page.getByTestId('filters-button');
	for (let i = 0; i < 40 && !(await filters.evaluate((el) => el === document.activeElement)); i++)
		await page.keyboard.press('Tab');
	await expect(filters).toBeFocused();
	const ring = await filters.evaluate((el) => {
		const cs = getComputedStyle(el);
		return { width: cs.outlineWidth, style: cs.outlineStyle };
	});
	expect(ring.style).not.toBe('none');
	expect(parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
	await page.keyboard.press('Enter');
	await expect(page.getByRole('checkbox', { name: /^planned/ })).toBeVisible();
	await page.keyboard.press('Escape');
	// The account menu opens with the keyboard and holds sign out
	const menu = page.getByTestId('account-menu');
	await menu.focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
	await page.keyboard.press('Escape');
	// Settings tabs are links, so Tab and Enter move between sections
	await page.goto('/acme/settings');
	await page.getByTestId('settings-tab-palette').focus();
	await page.keyboard.press('Enter');
	await expect(page.getByTestId('section-palette')).toBeVisible();
	await ctx.close();
});

test('M2 accessibility: reduced motion switches the overlay transitions off', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL, reducedMotion: 'reduce' });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	await page.goto('/acme/CKT');
	await page.getByTestId('new-item').click();
	const panel = page.getByRole('dialog');
	await expect(panel).toBeVisible();
	const property = await panel.evaluate((el) => getComputedStyle(el).transitionProperty);
	expect(property).toBe('none');
	await ctx.close();
});
