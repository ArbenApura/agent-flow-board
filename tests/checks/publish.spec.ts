// M10: Publish now writes Markdown and JSON to a test repo, private items are left out, a public repo refuses private
// content, and a cancelled delayed publish writes nothing. Also the connect flow, the diff, the visible failure notices,
// retry after a rate limit, the webhook, and who may publish. GitHub is a stand in server (tests/runner/github-mock.mjs).
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { signIn } from './helpers';

const MOCK = `http://localhost:${process.env.AFB_GITHUB_MOCK_PORT ?? 5181}`;
const ACME = '/api/v1/orgs/acme';
const INSTALL = '4242';
const SECRET = 'test-webhook-secret';
const tag = Date.now().toString(36).toUpperCase().slice(-5);
let counter = 0;

/** Signs in as a seeded person in their own browser context. */
async function as(browser: Browser, baseURL: string, email: string) {
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await signIn(page, email);
	return { ctx, page };
}

const control = (request: APIRequestContext, path: string, data: unknown) =>
	request.post(`${MOCK}/__mock/${path}`, { data });
const repoFiles = async (request: APIRequestContext, repo: string) =>
	(await (await request.get(`${MOCK}/__mock/files?repo=${repo}`)).json()) as {
		files: Record<string, string>;
		commits: { sha: string; message: string }[];
	};

/** A project of its own, with a public and a private item, and a repository to publish into. */
async function setup(page: Page, request: APIRequestContext, visibility: 'private' | 'public') {
	const key = `PB${tag}${++counter}`;
	const repo = `acme/${key.toLowerCase()}`;
	expect(
		(
			await page.request.post(`${ACME}/projects`, { data: { key, name: `Publish ${key}` } })
		).status()
	).toBe(200);
	const pub = await (
		await page.request.post(`${ACME}/projects/${key}/items`, {
			data: {
				title: 'Public plan for the reference copy',
				phases: [
					{ key: '1', title: 'Build', steps: [{ text: 'First step' }, { text: 'Second step' }] }
				]
			}
		})
	).json();
	const secret = await (
		await page.request.post(`${ACME}/projects/${key}/items`, {
			data: { title: 'Secret plan that stays private', visibility: 'private', phases: [] }
		})
	).json();
	await control(request, 'repo', { fullName: repo, private: visibility === 'private' });
	return { key, repo, pub, secret };
}

/** The org installs the App from the project, as a person does: the install link, then GitHub's redirect back. */
async function install(page: Page, key: string) {
	const start = await page.request.get(`/github/install?org=acme&project=${key}`, {
		maxRedirects: 0
	});
	const state = new URL(start.headers()['location']).searchParams.get('state')!;
	const back = await page.request.get(
		`/github/callback?installation_id=${INSTALL}&state=${state}`,
		{
			maxRedirects: 0
		}
	);
	expect(back.status()).toBe(303);
}

async function connect(page: Page, key: string, repo: string) {
	await install(page, key);
	await page.goto(`/acme/${key}/publish`);
	await page.getByTestId('installation-id').fill(INSTALL);
	await page.getByTestId('repo-name').fill(repo);
	await page.getByTestId('connect-repo').click();
	await expect(page.getByTestId('repo-link')).toHaveText(repo);
}

test('M10 connect a repository, preview the diff, Publish now writes Markdown and JSON and leaves private items out', async ({
	browser,
	baseURL,
	request
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'owner@acme.example');
	const { key, repo, pub, secret } = await setup(page, request, 'private');
	await page.goto(`/acme/${key}/publish`);
	await expect(page.getByText('Connect a repository')).toBeVisible();
	await connect(page, key, repo);
	await expect(page.getByTestId('repo-visibility')).toHaveText('private');
	// The diff says what the first publish will add, and names only the public item
	await expect(page.getByTestId('diff')).toContainText(pub.ref);
	await expect(page.getByTestId('diff')).not.toContainText(secret.ref);
	await expect(page.getByText('1 private item stays out')).toBeVisible();
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('run').first()).toHaveAttribute('data-state', 'done');
	await expect(page.getByTestId('no-changes')).toBeVisible();
	const { files, commits } = await repoFiles(request, repo);
	expect(Object.keys(files)).toEqual(
		expect.arrayContaining([
			'board/README.md',
			'board/registry.md',
			'board/snapshot.json',
			`board/items/${pub.ref}/PLAN.md`,
			`board/items/${pub.ref}/PROGRESS.md`
		])
	);
	expect(files[`board/items/${pub.ref}/PLAN.md`]).toContain('- [ ] 1.1 First step');
	const snapshot = JSON.parse(files['board/snapshot.json']);
	expect(snapshot.items.map((i: { ref: string }) => i.ref)).toEqual([pub.ref]);
	expect(JSON.stringify(files)).not.toContain('Secret plan');
	expect(JSON.stringify(files)).not.toContain(secret.ref);
	expect(commits[0].message).toContain(`Publish ${key}`);
	// The history links the commit
	await expect(page.getByTestId('runs')).toContainText(commits[0].sha.slice(0, 7));
	// Publishing again with nothing changed writes nothing and says so
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('runs')).toContainText('Nothing had changed');
	expect((await repoFiles(request, repo)).commits.length).toBe(commits.length);
	// A change shows in the diff, and only that item is rewritten
	await page.request.post(`${ACME}/items/${pub.ref}/record`, {
		data: { marks: [{ key: '1.1', mark: 'done' }] }
	});
	await page.reload();
	await expect(page.getByTestId('diff')).toContainText('changed');
	await page.getByTestId('publish-now').click();
	await expect
		.poll(async () => (await repoFiles(request, repo)).files[`board/items/${pub.ref}/PLAN.md`], {
			timeout: 10_000
		})
		.toContain('- [x] 1.1 First step');
	await ctx.close();
});

test('M10 a public repository refuses private content with the reason, and writes nothing', async ({
	browser,
	baseURL,
	request
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'owner@acme.example');
	const { key, repo, secret } = await setup(page, request, 'public');
	await connect(page, key, repo);
	await expect(page.getByTestId('repo-visibility')).toHaveText('public');
	await expect(page.getByTestId('refusal')).toContainText(
		'public and the project holds 1 private item'
	);
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('publish-error')).toContainText('Nothing was published');
	await expect(page.getByTestId('run').first()).toHaveAttribute('data-state', 'failed');
	expect(Object.keys((await repoFiles(request, repo)).files)).toEqual(['README.md']);
	// Make the private item public: the refusal goes and the publish works
	await page.request.patch(`${ACME}/items/${secret.ref}`, { data: { visibility: 'public' } });
	await page.reload();
	await expect(page.getByTestId('refusal')).toHaveCount(0);
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('run').first()).toHaveAttribute('data-state', 'done');
	expect(Object.keys((await repoFiles(request, repo)).files)).toContain(
		`board/items/${secret.ref}/PLAN.md`
	);
	await ctx.close();
});

test('M10 a cancelled delayed publish writes nothing, and one left alone writes when its time comes', async ({
	browser,
	baseURL,
	request
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'owner@acme.example');
	const { key, repo } = await setup(page, request, 'private');
	await connect(page, key, repo);
	const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
	const first = await page.request.post(`${ACME}/projects/${key}/publish`, {
		data: { runAt: later(8) }
	});
	expect(first.status()).toBe(200);
	await page.reload();
	await expect(page.getByTestId('pending')).toBeVisible();
	await page.getByTestId('cancel-publish').click();
	await expect(page.getByTestId('pending')).toHaveCount(0);
	await expect(page.getByTestId('run').first()).toHaveAttribute('data-state', 'cancelled');
	// The time passes: nothing was written
	await page.waitForTimeout(10_000);
	expect(Object.keys((await repoFiles(request, repo)).files)).toEqual(['README.md']);
	// Cancelling again is harmless
	const again = await page.request.post(
		`${ACME}/publish-runs/${(await first.json()).run.id}/cancel`
	);
	expect((await again.json()).cancelled).toBe(false);
	// One left alone writes
	expect(
		(
			await page.request.post(`${ACME}/projects/${key}/publish`, { data: { runAt: later(6) } })
		).status()
	).toBe(200);
	await expect
		.poll(async () => Object.keys((await repoFiles(request, repo)).files).length, {
			timeout: 20_000,
			intervals: [1000]
		})
		.toBeGreaterThan(1);
	await page.reload();
	await expect(page.getByTestId('run').first()).toHaveAttribute('data-state', 'done');
	await ctx.close();
});

test('M10 a rate limit is retried by itself and shown while it waits', async ({
	browser,
	baseURL,
	request
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'owner@acme.example');
	const { key, repo } = await setup(page, request, 'private');
	await connect(page, key, repo);
	await control(request, 'limit', { count: 1, status: 403, retryAfter: 2 });
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('pending')).toContainText('limiting requests');
	await expect(page.getByTestId('cancel-publish')).toBeVisible();
	await expect
		.poll(async () => Object.keys((await repoFiles(request, repo)).files).length, {
			timeout: 30_000,
			intervals: [1000]
		})
		.toBeGreaterThan(1);
	await page.reload();
	await expect(page.getByTestId('run').first()).toHaveAttribute('data-state', 'done');
	await ctx.close();
});

test('M10 a failing publish shows its error, and the webhook follows the repository and pauses when the App is removed', async ({
	browser,
	baseURL,
	request
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'owner@acme.example');
	const { key, repo } = await setup(page, request, 'private');
	await connect(page, key, repo);
	// GitHub answers an error that no retry can fix: the run fails at once and says why, with nothing written
	await control(request, 'fail', { count: 1, status: 422 });
	await page.getByTestId('publish-now').click();
	await expect(page.getByTestId('publish-error')).toContainText('GitHub answered 422');
	await expect(page.getByTestId('run').first()).toHaveAttribute('data-state', 'failed');
	expect(Object.keys((await repoFiles(request, repo)).files)).toEqual(['README.md']);
	// Webhooks: a bad signature is refused, a good one changes the visibility shown
	const send = (event: string, body: unknown, signature?: string) => {
		const raw = JSON.stringify(body);
		return request.post('/github/webhook', {
			data: raw,
			headers: {
				'content-type': 'application/json',
				'x-github-event': event,
				'x-hub-signature-256':
					signature ?? `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`
			}
		});
	};
	expect((await send('ping', {}, 'sha256=' + '0'.repeat(64))).status()).toBe(401);
	expect((await send('ping', {}, 'nonsense')).status()).toBe(401);
	expect((await send('ping', {})).status()).toBe(200);
	expect(
		(
			await send('repository', {
				action: 'publicized',
				installation: { id: Number(INSTALL) },
				repository: { full_name: repo }
			})
		).status()
	).toBe(200);
	await page.goto(`/acme/${key}/publish`);
	await expect(page.getByTestId('repo-visibility')).toHaveText('public');
	expect(
		(
			await send('repository', {
				action: 'privatized',
				installation: { id: Number(INSTALL) },
				repository: { full_name: repo }
			})
		).status()
	).toBe(200);
	// An unknown installation is accepted and ignored
	expect(
		(await send('installation', { action: 'deleted', installation: { id: 999999 } })).status()
	).toBe(202);
	// The App is removed from the repository: publishing pauses and says why
	await page.request.patch(`${ACME}/projects/${key}/publish/settings`, {
		data: { autoPublish: true }
	});
	expect(
		(
			await send('installation_repositories', {
				action: 'removed',
				installation: { id: Number(INSTALL) },
				repositories_removed: [{ full_name: repo }]
			})
		).status()
	).toBe(200);
	await page.reload();
	await expect(page.getByTestId('paused')).toContainText('removed from this repository');
	await ctx.close();
});

test('M10 only admins and owners publish: a member and a viewer see the state, not the buttons, and the API refuses them', async ({
	browser,
	baseURL,
	request
}) => {
	const owner = await as(browser, baseURL!, 'owner@acme.example');
	const { key, repo } = await setup(owner.page, request, 'private');
	await connect(owner.page, key, repo);
	for (const email of ['member@acme.example', 'viewer@acme.example']) {
		const person = await as(browser, baseURL!, email);
		await person.page.goto(`/acme/${key}/publish`);
		await expect(person.page.getByTestId('repo-link')).toHaveText(repo);
		await expect(person.page.getByTestId('publish-now')).toHaveCount(0);
		await expect(person.page.getByTestId('publish-later')).toHaveCount(0);
		const res = await person.page.request.post(`${ACME}/projects/${key}/publish`, { data: {} });
		expect(res.status()).toBe(403);
		expect(
			(
				await person.page.request.put(`${ACME}/projects/${key}/publish/link`, {
					data: { installationId: INSTALL, repo }
				})
			).status()
		).toBe(403);
		expect(
			(await person.page.request.get(`${ACME}/projects/${key}/publish/preview`)).status()
		).toBe(403);
		await person.ctx.close();
	}
	await owner.ctx.close();
});

test('M10 the manifest has no secrets, the install start needs a person who may publish, and a bad callback is refused', async ({
	browser,
	baseURL,
	request
}) => {
	const manifest = await (await request.get('/github/manifest.json')).json();
	expect(manifest.hook_attributes.url).toBe(`${baseURL}/github/webhook`);
	expect(JSON.stringify(manifest)).not.toMatch(/secret|private|key/i);
	const owner = await as(browser, baseURL!, 'owner@acme.example');
	const { key } = await setup(owner.page, request, 'private');
	// The install start sends an admin to GitHub with a signed state
	const start = await owner.page.request.get(`/github/install?org=acme&project=${key}`, {
		maxRedirects: 0
	});
	expect(start.status()).toBe(303);
	const location = new URL(start.headers()['location']);
	expect(location.pathname).toBe('/apps/afb-test-app/installations/new');
	const state = location.searchParams.get('state')!;
	expect(state).toMatch(/^[\w-]+\.[\w-]+$/);
	// A member may not start it
	const member = await as(browser, baseURL!, 'member@acme.example');
	expect(
		(
			await member.page.request.get(`/github/install?org=acme&project=${key}`, { maxRedirects: 0 })
		).status()
	).toBe(403);
	// The callback needs the state, from the same person
	expect(
		(
			await owner.page.request.get(`/github/callback?installation_id=${INSTALL}&state=junk`, {
				maxRedirects: 0
			})
		).status()
	).toBe(400);
	expect(
		(
			await member.page.request.get(`/github/callback?installation_id=${INSTALL}&state=${state}`, {
				maxRedirects: 0
			})
		).status()
	).toBe(400);
	const back = await owner.page.request.get(
		`/github/callback?installation_id=${INSTALL}&state=${state}`,
		{ maxRedirects: 0 }
	);
	expect(back.status()).toBe(303);
	expect(back.headers()['location']).toBe(`/acme/${key}/publish?installation=${INSTALL}`);
	// With the installation id the page offers the repositories the App can reach
	await control(request, 'repo', { fullName: `acme/${key.toLowerCase()}-pick`, private: true });
	await owner.page.goto(`/acme/${key}/publish?installation=${INSTALL}`);
	await expect(owner.page.getByTestId('repo-list')).toContainText(`acme/${key.toLowerCase()}-pick`);
	// The repository made for this project, not the first in the list: two projects may not publish into the same folder
	await owner.page
		.getByRole('listitem')
		.filter({ hasText: `acme/${key.toLowerCase()}-pick` })
		.getByRole('button', { name: 'Connect' })
		.click();
	await expect(owner.page.getByTestId('repo-link')).toBeVisible();
	await member.ctx.close();
	await owner.ctx.close();
});
