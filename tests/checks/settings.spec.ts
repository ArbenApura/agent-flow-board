/* eslint-disable @typescript-eslint/no-explicit-any -- API replies are parsed from JSON and read loosely in checks */
// M8: the automatic publish switch turns on and off and persists, delay and schedule save, the palette live preview shows both
// modes, the "Agents may set COMPLETED" switch persists, and each settings section saves on its own. Organisation changes run in
// a fresh organisation of their own, so they never disturb the seeded one the other checks use.
import { expect, test, type Browser } from '@playwright/test';
import { hexToRgb, generatePalette } from '../../src/lib/theme/palette';
import { PASSWORD, confirmAsk, installApp, newPerson, signIn } from './helpers';

const MOCK = `http://localhost:${process.env.AFB_GITHUB_MOCK_PORT ?? 5181}`;
const tag = Date.now().toString(36).toLowerCase().slice(-5);
let counter = 0;
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64'
);

async function as(browser: Browser, baseURL: string, email: string) {
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await signIn(page, email);
	return { ctx, page };
}

/** A new person with a new organisation of their own, on the settings page. */
async function ownOrg(browser: Browser, baseURL: string) {
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	const email = await newPerson(page, 'settings');
	const slug = `set${tag}${++counter}`;
	await page.getByLabel('Organisation name').fill(`Settings ${slug}`);
	await page.getByLabel('Address').fill(slug);
	await page.getByRole('button', { name: 'Create organisation' }).click();
	await expect(page.getByTestId('org-name')).toContainText(`Settings ${slug}`);
	return { ctx, page, slug, email };
}

const rgb = (hex: string) => {
	const [r, g, b] = hexToRgb(hex).map((v) => Math.round(v * 255));
	return `rgb(${r}, ${g}, ${b})`;
};

// Opens the settings tab of one section. Sections stay mounted, so edits typed in another tab are kept
const tab = async (p: import('@playwright/test').Page, id: string) => {
	await p.getByTestId(`settings-tab-${id}`).click();
	await expect(p.getByTestId(`section-${id}`)).toBeVisible();
};

test('M8 an organisation: each section saves on its own, the palette preview shows both modes and persists, the logo and limits work', async ({
	browser,
	baseURL
}) => {
	const { ctx, page, slug } = await ownOrg(browser, baseURL!);
	const api = `/api/v1/orgs/${slug}`;
	// A first project, made in the dialog of the organisation page
	await page.goto(`/${slug}`);
	await page.getByTestId('new-project').click();
	await page.getByTestId('project-name').fill('Audit project');
	await page.getByTestId('project-key').fill('AUD');
	await page.getByTestId('project-create').click();
	await expect(page).toHaveURL(new RegExp(`/${slug}/AUD$`));
	await page.goto(`/${slug}/settings`);
	await expect(page.getByTestId('page-title')).toHaveText('Organisation settings');

	// The name saves alone: a limit changed and saved next to an unsaved name leaves that name unsaved
	await tab(page, 'general');
	await page.getByTestId('org-name-input').fill('Renamed organisation');
	await expect(page.getByTestId('save-general')).toBeEnabled();
	await expect(page.getByTestId('save-palette')).toBeDisabled();
	await tab(page, 'limits');
	await page.getByRole('button', { name: 'Longest life of an access token' }).click();
	await page.getByRole('option', { name: '14 days' }).click();
	await page.getByRole('switch', { name: 'Guests may be invited' }).click();
	await page.getByTestId('save-limits').click();
	await expect(page.getByTestId('saved-limits')).toBeVisible();
	let saved = await (await page.request.get(`${api}/settings`)).json();
	expect(saved.name).toBe(`Settings ${slug}`);
	expect(saved.settings).toEqual({ tokenMaxDays: 14, allowGuestInvites: false });
	await tab(page, 'general');
	await expect(page.getByTestId('org-name-input')).toHaveValue('Renamed organisation');
	await expect(page.getByTestId('save-general')).toBeEnabled();
	await tab(page, 'general');
	await page.getByTestId('save-general').click();
	await expect(page.getByTestId('saved-general')).toBeVisible();
	await expect(page.getByTestId('org-name')).toHaveText('Renamed organisation');
	saved = await (await page.request.get(`${api}/settings`)).json();
	expect(saved).toMatchObject({
		name: 'Renamed organisation',
		settings: { tokenMaxDays: 14, allowGuestInvites: false }
	});

	// The limits are enforced: a token may not live longer than 14 days, and guests are not invited
	const long = await page.request.post(`${api}/tokens`, {
		data: { name: 'too long', days: 30, permissions: ['read'] }
	});
	expect(long.status()).toBe(400);
	expect((await long.json()).error.message).toContain('14 days at most');
	const guest = await page.request.post(`${api}/invites`, {
		data: { email: `guest-${tag}@example.com`, role: 'guest' }
	});
	expect(guest.status()).toBe(403);

	// The palette: the live preview shows both modes before anything is saved
	const rose = generatePalette('#e11d48');
	await tab(page, 'palette');
	await page.getByRole('radio', { name: 'Rose' }).click();
	const swatch = (mode: string) =>
		page.getByTestId(`preview-${mode}`).locator('span.bg-accent').first();
	await expect(swatch('light')).toHaveCSS('background-color', rgb(rose.light.accent));
	await expect(swatch('dark')).toHaveCSS('background-color', rgb(rose.dark.accent));
	await expect(page.getByTestId('palette-contrast')).toBeVisible();
	await expect(page.getByTestId('save-palette')).toBeEnabled();
	// Nothing changed on the page itself yet
	expect(await page.evaluate(() => document.getElementById('afb-palette'))).toBeNull();
	await page.getByTestId('save-palette').click();
	await expect(page.getByTestId('saved-palette')).toBeVisible();
	// It applies at once, and again after a reload, in both modes
	await expect
		.poll(() =>
			page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
			)
		)
		.toBe(rose.light.accent);
	await page.reload();
	await expect(page.getByRole('radio', { name: 'Rose' })).toHaveAttribute('aria-checked', 'true');
	await page.evaluate(() => (document.documentElement.dataset.mode = 'dark'));
	expect(
		await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
		)
	).toBe(rose.dark.accent);
	await page.evaluate(() => (document.documentElement.dataset.mode = 'light'));
	// Another member of the org sees the same palette, and the default goes back with one click
	await page.getByTestId('palette-reset').click();
	await page.getByTestId('save-palette').click();
	await expect(page.getByTestId('saved-palette')).toBeVisible();
	await expect.poll(() => page.evaluate(() => document.getElementById('afb-palette'))).toBeNull();
	// A colour typed by hand, and a wrong one
	await page.getByTestId('palette-hex').fill('#12');
	await expect(page.getByText('six digit colour')).toBeVisible();
	await page.getByTestId('palette-hex').fill('#0d9488');
	await expect(page.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'true');

	// The logo: a picture shows in the header, a big file is refused with its reason, and it can be removed
	await page
		.getByTestId('logo-file')
		.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
	await expect(page.getByTestId('org-logo')).toBeVisible();
	await page.getByTestId('logo-file').setInputFiles({
		name: 'big.png',
		mimeType: 'image/png',
		buffer: Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(210 * 1024)])
	});
	await expect(page.getByText('smaller than 200 KB')).toBeVisible();
	await page.getByTestId('logo-remove').click();
	await expect(page.getByTestId('org-logo')).toHaveCount(0);

	// Email: the test mail says it was sent, and shows up in the outbox
	await tab(page, 'email');
	await page.getByTestId('test-email').click();
	await expect(page.getByTestId('test-email-result')).toContainText('Sent to');
	// Backups are not set up in the preview, and the page says so
	await tab(page, 'backups');
	await expect(page.getByTestId('backups-off')).toBeVisible();
	// The audit log lists what was changed here, and filters by project
	await tab(page, 'audit');
	await expect(page.getByTestId('audit-list')).toContainText('changed the organisation settings');
	await page.getByRole('button', { name: 'Project', exact: true }).click();
	await page.getByRole('option', { name: 'AUD' }).click();
	await expect(page.getByTestId('audit-event').first()).toContainText('AUD');
	await ctx.close();
});

test('M8 a project: the Agents may set COMPLETED switch, the publish switch with its delay and schedule, and other sections persist', async ({
	browser,
	baseURL,
	request
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'owner@acme.example');
	const key = `ST${tag.toUpperCase()}${++counter}`;
	const repo = `acme/${key.toLowerCase()}`;
	await page.request.post('/api/v1/orgs/acme/projects', { data: { key, name: `Settings ${key}` } });
	await request.post(`${MOCK}/__mock/repo`, { data: { fullName: repo, private: true } });
	await installApp(page, 'acme', key);
	await page.request.put(`/api/v1/orgs/acme/projects/${key}/publish/link`, {
		data: { installationId: '4242', repo }
	});
	const project = async () =>
		(await (await page.request.get(`/api/v1/orgs/acme/projects/${key}`)).json()) as any;
	const publish = async () =>
		(await (await page.request.get(`/api/v1/orgs/acme/projects/${key}/publish`)).json()) as any;
	await page.goto(`/acme/${key}/settings`);
	await expect(page.getByTestId('page-title')).toHaveText('Project settings');

	// The switch persists: off, saved, reload, still off, then back on
	await tab(page, 'agents');
	const agents = page.getByRole('switch', { name: 'Agents may set COMPLETED' });
	await expect(agents).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByTestId('save-agents')).toBeDisabled();
	await agents.click();
	await expect(agents).toHaveAttribute('aria-checked', 'false');
	await page.getByTestId('save-agents').click();
	await expect(page.getByTestId('saved-agents')).toBeVisible();
	expect((await project()).agentsMayComplete).toBe(false);
	await page.reload();
	await expect(page.getByRole('switch', { name: 'Agents may set COMPLETED' })).toHaveAttribute(
		'aria-checked',
		'false'
	);
	await page.getByRole('switch', { name: 'Agents may set COMPLETED' }).click();
	await page.getByTestId('save-agents').click();
	await expect(page.getByTestId('saved-agents')).toBeVisible();
	expect((await project()).agentsMayComplete).toBe(true);

	// Automatic publish: on, a delay and a schedule, all saved by their own section
	await tab(page, 'publishing');
	await expect(page.getByRole('switch', { name: 'Publish automatically' })).toHaveAttribute(
		'aria-checked',
		'false'
	);
	await page.getByRole('switch', { name: 'Publish automatically' }).click();
	await page.getByRole('button', { name: 'Wait this long after a change' }).click();
	await page.getByRole('option', { name: '30 minutes' }).click();
	await page.getByRole('switch', { name: 'Only publish inside a time window' }).click();
	await page.getByRole('checkbox', { name: 'Sat' }).click();
	await page.getByRole('checkbox', { name: 'Mon' }).click();
	await page.getByLabel('From').fill('08:30');
	await page.getByLabel('To', { exact: true }).fill('17:45');
	await page.getByRole('button', { name: 'Time zone' }).click();
	await page.getByRole('option', { name: 'Europe/Berlin' }).click();
	await page.getByTestId('save-publishing').click();
	await expect(page.getByTestId('saved-publishing')).toBeVisible();
	let state = await publish();
	expect(state.link).toMatchObject({
		autoPublish: true,
		delayMinutes: 30,
		schedule: { days: [2, 3, 4, 5, 6], from: '08:30', to: '17:45', timezone: 'Europe/Berlin' }
	});
	// Persists across a reload, and shows as it was saved
	await page.reload();
	await expect(page.getByRole('switch', { name: 'Publish automatically' })).toHaveAttribute(
		'aria-checked',
		'true'
	);
	await expect(page.getByRole('button', { name: 'Wait this long after a change' })).toContainText(
		'30 minutes'
	);
	await expect(page.getByLabel('From')).toHaveValue('08:30');
	await expect(page.getByRole('checkbox', { name: 'Sat' })).toHaveAttribute('aria-checked', 'true');
	await expect(page.getByRole('checkbox', { name: 'Mon' })).toHaveAttribute(
		'aria-checked',
		'false'
	);
	// Off again, the window off, and that persists too
	await page.getByRole('switch', { name: 'Publish automatically' }).click();
	await page.getByRole('switch', { name: 'Only publish inside a time window' }).click();
	await page.getByTestId('save-publishing').click();
	await expect(page.getByTestId('saved-publishing')).toBeVisible();
	state = await publish();
	expect(state.link).toMatchObject({ autoPublish: false, delayMinutes: 30, schedule: null });
	await page.reload();
	await expect(page.getByRole('switch', { name: 'Publish automatically' })).toHaveAttribute(
		'aria-checked',
		'false'
	);

	// Each section saves alone: an unsaved name stays unsaved while the tracking section saves
	await tab(page, 'general');
	await page.getByTestId('project-name-input').fill('Name typed but not saved');
	await tab(page, 'tracking');
	await page.getByRole('button', { name: 'Quiet after' }).click();
	await page.getByRole('option', { name: '7 days' }).click();
	await page.getByTestId('save-tracking').click();
	await expect(page.getByTestId('saved-tracking')).toBeVisible();
	expect(await project()).toMatchObject({ staleDays: 7, name: `Settings ${key}` });
	await expect(page.getByTestId('save-general')).toBeEnabled();
	// Streams and UI shots
	await tab(page, 'streams');
	await page.getByTestId('add-stream').click();
	await page.getByLabel('Stream', { exact: true }).fill('features');
	await page.getByRole('textbox', { name: 'Scopes' }).fill('core');
	await page.getByRole('textbox', { name: 'Scopes' }).press('Enter');
	await page.getByTestId('save-streams').click();
	await expect(page.getByTestId('saved-streams')).toBeVisible();
	expect((await project()).streams).toEqual([{ stream: 'features', scopes: ['core'] }]);
	await tab(page, 'shots');
	await page.getByRole('textbox', { name: 'Reference pages' }).fill('/acme/CKT');
	await page.getByRole('textbox', { name: 'Reference pages' }).press('Enter');
	await page.getByTestId('save-shots').click();
	await expect(page.getByTestId('saved-shots')).toBeVisible();
	expect((await project()).referencePages).toEqual(['/acme/CKT']);
	// The export downloads hold the project and never a private item
	const secret = await (
		await page.request.post(`/api/v1/orgs/acme/projects/${key}/items`, {
			data: { title: 'Secret export item', visibility: 'private', phases: [] }
		})
	).json();
	const shown = await (
		await page.request.post(`/api/v1/orgs/acme/projects/${key}/items`, {
			data: { title: 'Public export item', phases: [] }
		})
	).json();
	const json = await page.request.get(`/acme/${key}/export.json`);
	expect(json.status()).toBe(200);
	expect(json.headers()['content-disposition']).toContain(`${key}-snapshot.json`);
	const text = await json.text();
	expect(text).toContain(shown.ref);
	expect(text).not.toContain(secret.ref);
	const md = await page.request.get(`/acme/${key}/export.md`);
	expect(md.headers()['content-disposition']).toContain(`${key}.md`);
	expect(await md.text()).toContain('Public export item');
	await ctx.close();
});

test('M8 your own settings: name, theme, accent, notifications, password, sessions and tools', async ({
	browser,
	baseURL,
	request
}) => {
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	const email = await newPerson(page, 'mine');
	await page.goto('/settings');
	await expect(page.getByTestId('page-title')).toHaveText('Your settings');
	// Name
	await page.getByTestId('profile-name').fill('Renamed Person');
	await page.getByTestId('save-profile').click();
	await expect(page.getByTestId('saved-profile')).toBeVisible();
	await page.reload();
	await expect(page.getByTestId('profile-name')).toHaveValue('Renamed Person');
	// Theme: dark applies at once and stays after reloading, from the settings and from the top bar switch
	await tab(page, 'appearance');
	await expect(page.getByTestId('save-appearance')).toHaveCount(0);
	await page.getByRole('radio', { name: 'Dark' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
	await page.getByTestId('theme-toggle').click();
	await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
	// There is no personal accent: the colour comes from the organisation
	await tab(page, 'appearance');
	await expect(page.getByRole('radio', { name: 'Violet' })).toHaveCount(0);
	// Notifications and the check target
	await tab(page, 'notifications');
	await page.getByRole('switch', { name: 'Backup problems' }).click();
	await page.getByTestId('save-notifications').click();
	await expect(page.getByTestId('saved-notifications')).toBeVisible();
	await tab(page, 'checks');
	await page.getByRole('button', { name: 'Run checks on' }).click();
	await page.getByRole('option', { name: 'Build preview' }).click();
	await page.getByTestId('save-checks').click();
	await expect(page.getByTestId('saved-checks')).toBeVisible();
	await page.reload();
	await tab(page, 'notifications');
	await expect(page.getByRole('switch', { name: 'Backup problems' })).toHaveAttribute(
		'aria-checked',
		'false'
	);
	await expect(page.getByRole('switch', { name: 'Publishing paused' })).toHaveAttribute(
		'aria-checked',
		'true'
	);
	await tab(page, 'checks');
	await expect(page.getByRole('button', { name: 'Run checks on' })).toContainText('Build preview');
	// Sessions: sign in from a second browser, see both, end the other one
	const other = await browser.newContext({ baseURL });
	const op = await other.newPage();
	await signIn(op, email, PASSWORD);
	await page.reload();
	await tab(page, 'sessions');
	await expect(page.getByTestId('session')).toHaveCount(2);
	await expect(page.getByTestId('session').filter({ hasText: 'this one' })).toHaveCount(1);
	await page.getByTestId('end-others').click();
	await confirmAsk(page, 'End them');
	await expect(page.getByTestId('session')).toHaveCount(1);
	await op.goto('/settings');
	await expect(op).toHaveURL(/sign-in/);
	await other.close();
	// Password: a wrong current one is refused with a plain message, the right one changes it
	await tab(page, 'signin');
	await page.getByTestId('password-current').fill('definitely not it');
	await page.getByTestId('password-new').fill('another long password');
	await page.getByTestId('save-signin').click();
	await expect(page.getByTestId('error-signin')).toBeVisible();
	await page.getByTestId('password-current').fill(PASSWORD);
	await page.getByTestId('save-signin').click();
	await expect(page.getByTestId('saved-signin')).toBeVisible();
	// The new password signs in, the old one does not
	const fresh = await browser.newContext({ baseURL });
	const fp = await fresh.newPage();
	await fp.goto('/sign-in');
	await fp.getByLabel('Email').fill(email);
	await fp.getByLabel('Password').fill(PASSWORD);
	await fp.getByRole('button', { name: 'Sign in' }).click();
	await expect(fp.getByRole('alert')).toBeVisible();
	await fp.getByLabel('Password').fill('another long password');
	await fp.getByRole('button', { name: 'Sign in' }).click();
	await expect(fp.getByRole('heading', { name: 'Your organisations' })).toBeVisible();
	await fresh.close();
	// Tools: a token made in an org of this person shows up, and revoking it stops it at once
	await page.goto('/');
	const orgName = `Tools ${tag}${++counter}`;
	await page.getByLabel('Organisation name').fill(orgName);
	await page.getByLabel('Address').fill(`tools${tag}${counter}`);
	await page.getByRole('button', { name: 'Create organisation' }).click();
	await expect(page.getByTestId('org-name')).toContainText(orgName);
	const slug = `tools${tag}${counter}`;
	const minted = await (
		await page.request.post(`/api/v1/orgs/${slug}/tokens`, {
			data: { name: 'my tool', permissions: ['read'] }
		})
	).json();
	await page.goto('/settings');
	await tab(page, 'tools');
	await expect(page.getByTestId('tool')).toContainText('my tool');
	expect(
		(
			await request.get(`/api/v1/orgs/${slug}/projects`, {
				headers: { authorization: `Bearer ${minted.token}` }
			})
		).status()
	).toBe(200);
	await page.getByTestId('tool').getByRole('button', { name: 'Revoke' }).click();
	await confirmAsk(page, 'Revoke');
	await expect(page.getByTestId('tool')).toHaveCount(0);
	expect(
		(
			await request.get(`/api/v1/orgs/${slug}/projects`, {
				headers: { authorization: `Bearer ${minted.token}` }
			})
		).status()
	).toBe(401);
	await ctx.close();
});

test('M8 a member and a viewer see the settings but cannot change them, and the API refuses them', async ({
	browser,
	baseURL
}) => {
	for (const email of ['member@acme.example', 'viewer@acme.example']) {
		const { ctx, page } = await as(browser, baseURL!, email);
		await page.goto('/acme/settings');
		await expect(page.getByTestId('page-title')).toHaveText('Organisation settings');
		await expect(page.getByTestId('save-general')).toHaveCount(0);
		await expect(page.getByTestId('save-palette')).toHaveCount(0);
		await expect(page.getByTestId('section-audit')).toHaveCount(0);
		await expect(page.getByTestId('section-limits')).toHaveCount(0);
		await expect(page.getByText('Only an admin or owner can change this.').first()).toBeVisible();
		expect(
			(
				await page.request.patch('/api/v1/orgs/acme/settings', { data: { name: 'Hijacked' } })
			).status()
		).toBe(403);
		expect((await page.request.get('/api/v1/orgs/acme/audit')).status()).toBe(403);
		expect((await page.request.get('/api/v1/orgs/acme/backups')).status()).toBe(403);
		await page.goto('/acme/CKT/settings');
		await expect(page.getByTestId('save-general')).toHaveCount(0);
		await expect(page.getByTestId('save-agents')).toHaveCount(0);
		expect(
			(
				await page.request.patch('/api/v1/orgs/acme/projects/CKT', { data: { staleDays: 9 } })
			).status()
		).toBe(403);
		await ctx.close();
	}
	// An unsigned person is sent to sign in, and a token cannot change org settings
	const anon = await browser.newContext({ baseURL });
	const ap = await anon.newPage();
	await ap.goto('/settings');
	await expect(ap).toHaveURL(/sign-in/);
	await anon.close();
});

test('M8 the settings pages work on a phone: no sideways scroll and tap targets of 44 px', async ({
	browser,
	baseURL
}) => {
	const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 800 } });
	const page = await ctx.newPage();
	await signIn(page, 'owner@acme.example');
	for (const path of ['/settings', '/acme/settings', '/acme/CKT/settings']) {
		await page.goto(path);
		await expect(page.getByTestId('page-title')).toBeVisible();
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
		expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(0);
	}
	await page.goto('/acme/CKT/settings');
	const small = await page.evaluate(() =>
		[
			...document.querySelectorAll<HTMLElement>(
				'button, a[href], input:not([type=hidden]), [role=switch], [role=checkbox], [role=radio]'
			)
		]
			.filter(
				(e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden'
			)
			.map((e) => ({
				text: (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().slice(0, 30),
				h: e.getBoundingClientRect().height,
				tag: e.tagName
			}))
			.filter((e) => e.h < 40 && e.tag !== 'A' && e.tag !== 'INPUT')
	);
	expect(small, JSON.stringify(small)).toEqual([]);
	await ctx.close();
});
