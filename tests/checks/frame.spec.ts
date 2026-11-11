// ONE CONTAINER (FLOW-20261016-0935, ADR-003 AND SPEC 6.1). EVERY SCREEN, THE NAVIGATION INCLUDED, SITS IN THE SAME FRAME WITH THE SAME LEFT EDGE AND WIDTH

// -- DEP-MODULES -- //
import { expect, test } from '@playwright/test';
// -- MODULES -- //
import { signIn } from './helpers';

// -- CONSTANTS -- //

const ORG_SCREENS = [
	'/acme',
	'/acme/CKT',
	'/acme/CKT?view=list',
	'/acme/CKT/CKT-1',
	'/acme/CKT/tasks',
	'/acme/CKT/activity',
	'/acme/search?q=promo',
	'/acme/settings',
	'/acme/CKT/settings',
	'/acme/CKT/ui'
];
const OTHER_SCREENS = ['/', '/settings'];
const TOLERANCE_PX = 1;

// -- TESTS -- //

// 1920 is the frame's own maximum (AFB-20261111-1344): there the frame is 1856 wide beside the 64 px rail
for (const width of [1920, 1440, 390]) {
	test(`M2 frame at ${width}: every screen has the width and left edge of the navigation`, async ({
		browser,
		baseURL
	}) => {
		const ctx = await browser.newContext({ baseURL, viewport: { width, height: 900 } });
		const page = await ctx.newPage();
		await signIn(page, 'owner@acme.example');
		const box = async (testid: string) => {
			const b = await page.getByTestId(testid).first().boundingBox();
			expect(b, `${testid} is on the page`).not.toBeNull();
			return b!;
		};
		await page.goto('/acme/CKT');
		const nav = await box('nav-frame');
		const mismatches: string[] = [];
		for (const path of [...ORG_SCREENS, ...OTHER_SCREENS]) {
			await page.goto(path);
			const frame = await box('page-frame');
			const want = nav;
			if (
				Math.abs(frame.x - want.x) > TOLERANCE_PX ||
				Math.abs(frame.width - want.width) > TOLERANCE_PX
			)
				mismatches.push(
					`${path}: x ${frame.x} width ${frame.width}, navigation x ${want.x} width ${want.width}`
				);
		}
		expect(mismatches, mismatches.join('\n')).toEqual([]);
		await ctx.close();
	});
}
