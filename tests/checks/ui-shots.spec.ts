/* eslint-disable @typescript-eslint/no-explicit-any -- API replies are parsed from JSON and read loosely in checks */
// M18: a UI shots run shows before and after at desktop and phone in both themes, flags a measurement off the project scale, aborts a
// write the page tries, never opens production, and a private item's shots appear nowhere for someone who may not see it. The real
// runner program opens real pages of this preview, signed in as a seeded owner, and sends the numbers and pictures back.
import { expect, test, type Page } from '@playwright/test';
import { signIn, SEED_PASSWORD } from './helpers';
import { runRunner } from './runnerKit';

const ACME = '/api/v1/orgs/acme';
const tag = Date.now().toString(36).toUpperCase().slice(-4);
let counter = 0;
const OWNER = 'owner@acme.example';

const ok = async (r: Awaited<ReturnType<Page['request']['get']>>) => {
	expect(r.status(), await r.text()).toBe(200);
	return r.json();
};

/** A web app project with a preview, a demo site for the before pictures, a test account and an online runner. */
async function setup(page: Page, base: string, opts: { demoProduction?: boolean } = {}) {
	const key = `UI${tag}${++counter}`;
	await ok(
		await page.request.post(`${ACME}/projects`, {
			data: { key, name: `Shots ${key}`, webApp: true }
		})
	);
	await ok(
		await page.request.put(`${ACME}/projects/${key}/environments`, {
			data: { name: 'preview', url: base, kind: 'preview' }
		})
	);
	await ok(
		await page.request.put(`${ACME}/projects/${key}/environments`, {
			data: { name: 'demo', url: base, kind: 'deployed', production: Boolean(opts.demoProduction) }
		})
	);
	await ok(
		await page.request.put(`${ACME}/projects/${key}/accounts`, {
			data: { name: 'default', email: OWNER, password: SEED_PASSWORD }
		})
	);
	const runner = await ok(
		await page.request.post(`${ACME}/runners`, {
			data: { name: `Runner ${key}`, kind: 'local', projects: [key] }
		})
	);
	await ok(
		await page.request.post('/api/v1/runner/claim', {
			headers: { authorization: `Bearer ${runner.token}` }
		})
	);
	await ok(
		await page.request.patch(`${ACME}/projects/${key}`, {
			data: { referencePages: ['/acme', '/acme/CKT', '/acme/CKT/tasks', '/acme/CKT/activity'] }
		})
	);
	return { key, token: runner.token as string };
}

async function newItem(page: Page, key: string, title: string, extra: object = {}) {
	return ok(
		await page.request.post(`${ACME}/projects/${key}/items`, {
			data: {
				title,
				phases: [{ key: '1', title: 'Build', steps: [{ text: 'Build the page' }] }],
				...extra
			}
		})
	);
}

const rows = `| Page | State | Themes | Accounts | Siblings | Levels | Viewports |
| --- | --- | --- | --- | --- | --- | --- |
| \`/acme/CKT/health\` | none | both | default | \`/acme/CKT/tasks\` | title, section | 1440, 390 |
| \`/acme\` | \`click:form[action="/sign-out"] button\` | light | default | \`/acme/CKT\` | title | 1440 |
| \`/acme/CKT/health\` | none | light | default | \`/acme/CKT/tasks\` | title=css:h2 | 1440 |
`;

test('M18 a UI shots run shows before and after at desktop and phone in both themes, flags what is off the scale, and aborts a write', async ({
	browser,
	baseURL
}) => {
	test.setTimeout(300_000);
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await signIn(page, OWNER);
	const base = baseURL!;
	const p = await setup(page, base);
	const made = await newItem(page, p.key, 'Shots item');
	const ref = made.ref as string;

	// The scale is measured from the reference pages first, so there is something to flag against
	const asked = await ok(
		await page.request.post(`${ACME}/projects/${p.key}/scale/measure`, { data: {} })
	);
	expect(asked.unavailable).toBe(false);
	let ran = await runRunner(base, p.token, ['--trust-all']);
	expect(ran.out, ran.out).toContain('Finished.');
	const scale = await ok(await page.request.get(`${ACME}/projects/${p.key}/scale`));
	const desktop = scale.scales.find((s: any) => s.theme === 'light' && s.viewport === 1440);
	expect(desktop.levels.title.fontSize).toBe(24);
	expect(
		scale.scales.find((s: any) => s.theme === 'dark' && s.viewport === 390).levels.title.fontSize
	).toBe(20);

	// The table is checked first, then a run is asked for
	const bad = await page.request.put(`${ACME}/items/${ref}/ui-changes`, {
		data: { markdown: rows.replace('title, section', 'headline') }
	});
	expect(bad.status()).toBe(400);
	await ok(await page.request.put(`${ACME}/items/${ref}/ui-changes`, { data: { markdown: rows } }));
	const queued = await ok(await page.request.post(`${ACME}/items/${ref}/ui-shots`, { data: {} }));
	expect(queued.unavailable).toBe(false);
	ran = await runRunner(base, p.token, ['--trust-all']);
	expect(ran.out, ran.out).toContain('Finished.');

	const shots = await ok(await page.request.get(`${ACME}/items/${ref}/ui-shots`));
	const run = shots.runs[0];
	expect(run.state, run.reason).toBe('done');
	// Before (the demo site) and after, at both widths in both themes, with the sibling beside each
	const health = run.results.filter(
		(r: any) => r.page === '/acme/CKT/health' && r.state === '' && r.side !== 'sibling'
	);
	for (const theme of ['light', 'dark'])
		for (const viewport of [1440, 390])
			for (const side of ['before', 'after'])
				expect(
					health.some(
						(r: any) => r.theme === theme && r.viewport === viewport && r.side === side && r.image
					),
					`${side} ${theme} ${viewport}`
				).toBe(true);
	expect(
		run.results.filter((r: any) => r.side === 'sibling' && r.of === '/acme/CKT/health').length
	).toBeGreaterThanOrEqual(4);
	// A level read through a selector that is not the title is off the scale, and the server says so in words
	expect(
		run.flags.some(
			(f: any) =>
				f.kind === 'off-scale' &&
				f.page === '/acme/CKT/health' &&
				/title fontSize 18px/.test(f.text)
		)
	).toBe(true);
	// The click on Sign out tried to write: it was aborted and counted, and the run still finished
	expect(run.abortedWrites).toBeGreaterThanOrEqual(1);
	expect(typeof run.outsideCalls).toBe('number');
	expect(run.reason).toMatch(/Before is the deployed site/);
	expect(run.afterCommit === null || /^[0-9a-f]{7,40}$/.test(run.afterCommit)).toBe(true);
	expect(run.diffHash).toMatch(/^[0-9a-f]{40}$/);
	expect(run.changedPaths.length).toBeGreaterThan(0);
	// The person who owns the account is still signed in after the run: nothing was submitted
	expect((await page.request.get(`${ACME}/items/${ref}`)).status()).toBe(200);

	// The UI CHANGES tab shows before and after, the sibling, the flags, and the toggles
	await page.goto(`/acme/${p.key}/${ref}?tab=ui`);
	await expect(page.getByTestId('ui-results')).toBeVisible();
	const card = page.getByTestId('ui-page').first();
	await expect(card).toBeVisible();
	await expect(page.getByTestId('ui-flags').first()).toContainText('the scale says');
	await expect(card.locator('img').first()).toBeVisible();
	await expect
		.poll(() =>
			card
				.locator('img')
				.first()
				.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)
		)
		.toBe(true);
	await expect(card.getByText('Before, on the deployed site')).toBeVisible();
	await page.getByRole('radio', { name: 'Phone' }).click();
	await expect(page.getByTestId('ui-page').first()).toBeVisible();
	// The project UI page lists the item, with its flags
	await page.goto(`/acme/${p.key}/ui`);
	await expect(page.getByTestId('ui-run').filter({ hasText: ref })).toBeVisible();
	await expect(page.getByTestId('ui-run').filter({ hasText: ref })).toContainText('to fix');
	await ctx.close();
});

test('M18 a private item shows its shots to nobody who may not see it, and a viewer sees numbers without pictures', async ({
	browser,
	baseURL
}) => {
	test.setTimeout(300_000);
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await signIn(page, OWNER);
	const base = baseURL!;
	const p = await setup(page, base);
	const member = await browser.newContext({ baseURL });
	const mp = await member.newPage();
	await signIn(mp, 'member@acme.example');
	const open = await newItem(page, p.key, 'Open item');
	const secret = await newItem(mp, p.key, 'Private item', { visibility: 'private' });
	const small = `| Page | State | Themes | Accounts | Siblings | Levels | Viewports |
| --- | --- | --- | --- | --- | --- | --- |
| \`/acme/CKT/health\` | none | light | default | \`/acme/CKT/tasks\` | title | 1440 |
`;
	for (const [who, it] of [
		[page, open],
		[mp, secret]
	] as const) {
		await ok(
			await who.request.put(`${ACME}/items/${it.ref}/ui-changes`, { data: { markdown: small } })
		);
		await ok(await who.request.post(`${ACME}/items/${it.ref}/ui-shots`, { data: {} }));
	}
	const ran = await runRunner(base, p.token, ['--trust-all', '--max-jobs', '2']);
	expect(ran.out, ran.out).toContain('Finished.');
	const viewer = await browser.newContext({ baseURL });
	const vp = await viewer.newPage();
	await signIn(vp, 'viewer@acme.example');
	// The viewer sees the open item's numbers, not its pictures, and nothing at all of the private item
	const ui = await ok(await vp.request.get(`${ACME}/projects/${p.key}/ui`));
	expect(ui.canSeePictures).toBe(false);
	expect(ui.runs.map((r: any) => r.item.ref)).toContain(open.ref);
	expect(JSON.stringify(ui)).not.toContain(secret.ref);
	expect(ui.runs.every((r: any) => r.results.every((x: any) => !x.image))).toBe(true);
	expect((await vp.request.get(`${ACME}/items/${secret.ref}/ui-shots`)).status()).toBe(404);
	await vp.goto(`/acme/${p.key}/ui`);
	await expect(vp.getByTestId('ui-run').filter({ hasText: open.ref })).toBeVisible();
	await expect(vp.locator('body')).not.toContainText(secret.ref);
	await vp.goto(`/acme/${p.key}/${open.ref}?tab=ui`);
	await expect(vp.getByTestId('ui-results')).toBeVisible();
	await expect(vp.getByText('Pictures are private to members')).toBeVisible();
	// A picture address of the private item answers 404 for the viewer, and for the member who made it the picture opens
	const pics = await ok(await mp.request.get(`${ACME}/items/${secret.ref}/ui-shots`));
	const id = pics.runs[0].results.find((r: any) => r.image).image;
	expect((await vp.request.get(`/acme/shot/${id}`, { maxRedirects: 0 })).status()).toBe(404);
	expect((await mp.request.get(`/acme/shot/${id}`, { maxRedirects: 0 })).status()).toBe(302);
	await viewer.close();
	await member.close();
	await ctx.close();
});

test('M18 a UI shots run never opens a production site', async ({ browser, baseURL }) => {
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await signIn(page, OWNER);
	const p = await setup(page, baseURL!, { demoProduction: true });
	const made = await newItem(page, p.key, 'Production guard item');
	await ok(
		await page.request.put(`${ACME}/items/${made.ref}/ui-changes`, {
			data: { markdown: rows.split('\n').slice(0, 3).join('\n') }
		})
	);
	const asked = await ok(
		await page.request.post(`${ACME}/items/${made.ref}/ui-shots`, { data: { target: 'deployed' } })
	);
	expect(asked.unavailable).toBe(true);
	expect(asked.reason).toMatch(/production/);
	expect(asked.reason).toMatch(/preview/);
	await ctx.close();
});

test('M18 the checks and UI changes tabs and the settings sections are usable on a phone', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 800 } });
	const page = await ctx.newPage();
	await signIn(page, OWNER);
	const p = await setup(page, baseURL!);
	const made = await newItem(page, p.key, 'Phone item', {
		manualChecks: [{ key: 'M1', text: 'It opens', auto: true }]
	});
	for (const path of [
		`/acme/${p.key}/${made.ref}?tab=checks`,
		`/acme/${p.key}/${made.ref}?tab=ui`,
		`/acme/${p.key}/ui`,
		`/acme/${p.key}/settings`,
		'/acme/settings'
	]) {
		await page.goto(path);
		await expect(
			page
				.getByTestId('page-title')
				.or(page.getByTestId('checks-tab'))
				.or(page.getByTestId('ui-tab'))
				.first()
		).toBeVisible();
		const wide = await page.evaluate(
			() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
		);
		expect(wide, path).toBe(false);
	}
	await page.goto(`/acme/${p.key}/${made.ref}?tab=checks`);
	await expect(page.getByTestId('target-preview')).toContainText('Ready');
	await expect(page.getByTestId('check-M1')).toContainText('No browser check is saved');
	await ctx.close();
});
