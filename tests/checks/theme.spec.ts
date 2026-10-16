// M5: light, dark and system modes show no flash on load, every gallery component passes AA in both modes,
// and a low contrast seed colour is adjusted by the generator (SPEC 11).
import { expect, test, type Page } from '@playwright/test';

const GALLERY = '/dev/gallery';

/** Resolves any CSS colour to [r, g, b, a] through a canvas, so oklab and color-mix values work too. */
async function auditContrast(page: Page) {
	return page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 1;
		const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
		const rgba = (css: string): [number, number, number, number] => {
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = '#000';
			ctx.fillStyle = css;
			ctx.fillRect(0, 0, 1, 1);
			const d = ctx.getImageData(0, 0, 1, 1).data;
			return [d[0], d[1], d[2], d[3] / 255];
		};
		const lum = ([r, g, b]: number[]) => {
			const f = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
			return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
		};
		const over = (top: number[], bottom: number[]) => {
			const a = top[3];
			return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
		};
		const backdrop = (el: Element) => {
			const layers: number[][] = [];
			for (let n: Element | null = el; n; n = n.parentElement) {
				const c = rgba(getComputedStyle(n).backgroundColor);
				if (c[3] > 0) layers.push(c);
				if (c[3] >= 1) break;
			}
			let base = rgba(getComputedStyle(document.body).backgroundColor);
			if (base[3] === 0) base = rgba(getComputedStyle(document.documentElement).backgroundColor);
			let acc = base;
			for (const l of layers.reverse()) acc = over(l, acc) as [number, number, number, number];
			return acc;
		};
		const failures: { text: string; ratio: number; need: number; tag: string }[] = [];
		let checked = 0;
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let t = walker.nextNode(); t; t = walker.nextNode()) {
			const text = (t.textContent ?? '').trim();
			const el = t.parentElement;
			if (!text || !el) continue;
			const cs = getComputedStyle(el);
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') continue;
			// Disabled controls and the faded skeleton are exempt from contrast rules (WCAG 1.4.3)
			if (el.closest('[disabled], [aria-disabled="true"], [aria-busy="true"]')) continue;
			let faded = false;
			for (let n: Element | null = el; n; n = n.parentElement)
				if (Number(getComputedStyle(n).opacity) < 1) faded = true;
			if (faded) continue;
			const bg = backdrop(el);
			const fg = over(rgba(cs.color), bg);
			const l1 = lum(fg);
			const l2 = lum(bg);
			const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
			const size = parseFloat(cs.fontSize);
			const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
			const need = large ? 3 : 4.5;
			checked++;
			if (ratio < need)
				failures.push({
					text: text.slice(0, 40),
					ratio: Math.round(ratio * 100) / 100,
					need,
					tag: el.tagName
				});
		}
		return { checked, failures };
	});
}

test.describe('M5 theme', () => {
	for (const mode of ['light', 'dark'] as const) {
		test(`${mode} cookie renders ${mode} in the first HTML`, async ({ request }) => {
			const res = await request.get(GALLERY, { headers: { cookie: `afb-mode=${mode}` } });
			const html = await res.text();
			expect(html).toMatch(new RegExp(`<html[^>]*data-mode="${mode}"`));
			expect(html).toMatch(/data-system="0"/);
		});
	}

	test('system mode ships a blocking script and the page is correct before the body paints', async ({
		browser,
		request
	}) => {
		const html = await (await request.get(GALLERY)).text();
		expect(html).toMatch(/data-system="1"/);
		expect(html.indexOf('matchMedia')).toBeGreaterThan(-1);
		// The script sits in the head, before the body opens
		expect(html.indexOf('matchMedia')).toBeLessThan(html.indexOf('<body'));
		for (const scheme of ['dark', 'light'] as const) {
			const ctx = await browser.newContext({ colorScheme: scheme });
			const page = await ctx.newPage();
			await page.addInitScript(() => {
				new MutationObserver(() => {
					const w = window as unknown as { __modeAtBody?: string };
					if (document.body && !w.__modeAtBody)
						w.__modeAtBody = document.documentElement.dataset.mode;
				}).observe(document, { childList: true, subtree: true });
			});
			await page.goto(GALLERY);
			const atBody = await page.evaluate(
				() => (window as unknown as { __modeAtBody?: string }).__modeAtBody
			);
			expect(atBody, `mode when the body first existed under ${scheme}`).toBe(scheme);
			await ctx.close();
		}
	});

	test('an explicit choice survives a reload with no flash', async ({ page }) => {
		await page.goto(GALLERY);
		await page.getByRole('radio', { name: 'Dark' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
		const res = await page.reload();
		expect(await res!.text()).toMatch(/<html[^>]*data-mode="dark"/);
	});

	for (const mode of ['light', 'dark'] as const) {
		test(`every gallery component passes AA text contrast in ${mode}`, async ({ browser }) => {
			const ctx = await browser.newContext({
				storageState: {
					cookies: [
						{
							name: 'afb-mode',
							value: mode,
							domain: 'localhost',
							path: '/',
							expires: -1,
							httpOnly: false,
							secure: false,
							sameSite: 'Lax'
						}
					],
					origins: []
				}
			});
			const page = await ctx.newPage();
			await page.goto(GALLERY);
			await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
			const { checked, failures } = await auditContrast(page);
			expect(checked).toBeGreaterThan(80);
			expect(failures, JSON.stringify(failures, null, 1)).toEqual([]);
			await ctx.close();
		});
	}

	test('the contrast audit really catches a failing pair', async ({ page }) => {
		await page.goto(GALLERY);
		await page.evaluate(() => {
			const p = document.createElement('p');
			p.textContent = 'Deliberately faint text';
			p.style.color = '#d0d0d0';
			p.style.background = '#ffffff';
			document.body.prepend(p);
		});
		const { failures } = await auditContrast(page);
		expect(failures.map((f) => f.text)).toContain('Deliberately faint text');
	});

	test('a low contrast seed is adjusted and every pair passes', async ({ page }) => {
		await page.goto(GALLERY);
		await expect(page.getByTestId('palette-adjusted')).toContainText('adjusted');
		const rows = page.getByTestId('palette-pairs').locator('tbody tr');
		expect(await rows.count()).toBeGreaterThan(8);
		for (const text of await rows.allInnerTexts()) expect(text).toContain('Pass');
		await expect(page.getByTestId('palette-charts')).toContainText('16 of 16');
		// A pale seed that already passes is reported as passing
		await page.getByLabel('Seed colour (hex)').fill('#1d4ed8');
		await expect(page.getByTestId('palette-adjusted')).toContainText('passes as it is');
	});
});
