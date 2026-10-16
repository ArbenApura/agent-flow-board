/* eslint-disable @typescript-eslint/no-explicit-any -- tool and API replies are parsed from JSON and read loosely in checks */
// M9: a commit with an item trailer and no record shows as unrecorded work on the item and the health panel, and a step refuses
// fake evidence. Also the claim link, the pull request check, the health lists, and the hook endpoint the bridge calls.
// GitHub is a stand in server (tests/runner/github-mock.mjs), and its pushes arrive as signed webhooks.
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { installApp, signIn } from './helpers';

const MOCK = `http://localhost:${process.env.AFB_GITHUB_MOCK_PORT ?? 5181}`;
const ACME = '/api/v1/orgs/acme';
const INSTALL = '4242';
const SECRET = 'test-webhook-secret';
const tag = Date.now().toString(36).toUpperCase().slice(-5);
let counter = 0;

async function as(browser: Browser, baseURL: string, email: string) {
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await signIn(page, email);
	return { ctx, page };
}
const control = (request: APIRequestContext, path: string, data: unknown) =>
	request.post(`${MOCK}/__mock/${path}`, { data });

/** A project with a connected repository and an item with two steps. */
async function setup(page: Page, request: APIRequestContext) {
	const key = `TR${tag}${++counter}`;
	const repo = `acme/${key.toLowerCase()}`;
	expect(
		(
			await page.request.post(`${ACME}/projects`, { data: { key, name: `Tracking ${key}` } })
		).status()
	).toBe(200);
	await control(request, 'repo', { fullName: repo, private: true });
	await installApp(page, 'acme', key, INSTALL);
	expect(
		(
			await page.request.put(`${ACME}/projects/${key}/publish/link`, {
				data: { installationId: INSTALL, repo }
			})
		).status()
	).toBe(200);
	const made = await (
		await page.request.post(`${ACME}/projects/${key}/items`, {
			data: {
				title: 'Tracked work item',
				phases: [
					{ key: '1', title: 'Build', steps: [{ text: 'First step' }, { text: 'Second step' }] }
				]
			}
		})
	).json();
	return { key, repo, ref: made.ref as string, id: made.id as string };
}

/** Sends a webhook signed the way GitHub signs it. */
function webhook(request: APIRequestContext, event: string, body: unknown) {
	const raw = JSON.stringify(body);
	return request.post('/github/webhook', {
		data: raw,
		headers: {
			'content-type': 'application/json',
			'x-github-event': event,
			'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`
		}
	});
}
const sha = (n: number) => String(n).repeat(40).slice(0, 40);

test('M9 a commit with an item trailer and no record shows on the item and the health panel, and a record clears it', async ({
	browser,
	baseURL,
	request
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'owner@acme.example');
	const { key, repo, ref } = await setup(page, request);
	await page.goto(`/acme/${key}/health`);
	await expect(page.getByText('Nothing needs attention')).toBeVisible();
	// A push whose commit names the item in a trailer
	const pushed = await webhook(request, 'push', {
		installation: { id: Number(INSTALL) },
		repository: { full_name: repo },
		ref: 'refs/heads/main',
		commits: [
			{
				id: sha(1),
				message: `Add the cards\n\nItem: ${ref}`,
				timestamp: new Date().toISOString(),
				author: { email: 'dev@example.com' },
				modified: ['src/cards.ts']
			},
			{
				id: sha(2),
				message: 'A commit that names nothing',
				timestamp: new Date().toISOString(),
				author: { email: 'nobody@example.com' },
				modified: ['src/x.ts']
			}
		]
	});
	expect(pushed.status()).toBe(200);
	// The item says so
	await page.goto(`/acme/${key}/${ref}`);
	await expect(page.getByTestId('unrecorded-commits')).toContainText(
		'1 commit has no recorded step'
	);
	await expect(page.getByTestId('unrecorded-commits')).toContainText(sha(1).slice(0, 7));
	// The health panel lists it, and counts the commit that named no item
	await page.goto(`/acme/${key}/health`);
	await expect(page.getByTestId('unrecorded')).toContainText(ref);
	await expect(page.getByTestId('unrecorded-commit')).toHaveCount(1);
	await expect(page.getByText('1 commit named no item at all.')).toBeVisible();
	// The pull request check warns about both commits and never fails
	await control(request, 'commit', {
		repo,
		sha: sha(1),
		message: 'Add the cards',
		files: ['src/cards.ts']
	});
	await control(request, 'pull', { repo, number: 5, shas: [sha(1), sha(2)] });
	const pr = await webhook(request, 'pull_request', {
		action: 'opened',
		installation: { id: Number(INSTALL) },
		repository: { full_name: repo },
		pull_request: { number: 5, head: { sha: sha(2) } }
	});
	expect(pr.status()).toBe(200);
	const checks = (
		(await (await request.get(`${MOCK}/__mock/checks`)).json()) as {
			checks: { repo: string; conclusion: string; name: string; output: { summary: string } }[];
		}
	).checks.filter((c) => c.repo === repo);
	expect(checks).toHaveLength(1);
	expect(checks[0]).toMatchObject({ name: 'Board record', conclusion: 'neutral' });
	expect(checks[0].output.summary).toContain('no step was recorded');
	expect(checks[0].output.summary).toContain('is not linked to any item');
	expect(checks[0].output.summary).toContain('only warns');
	// Recording a step clears the item's notice and the health entry
	const recorded = await page.request.post(`${ACME}/items/${ref}/record`, {
		data: { marks: [{ key: '1.1', mark: 'done' }] }
	});
	expect(recorded.status()).toBe(200);
	await page.goto(`/acme/${key}/${ref}`);
	await expect(page.getByTestId('unrecorded-commits')).toHaveCount(0);
	await page.goto(`/acme/${key}/health`);
	await expect(page.getByTestId('unrecorded-commit')).toHaveCount(0);
	// A repeated push changes nothing
	const again = await webhook(request, 'push', {
		installation: { id: Number(INSTALL) },
		repository: { full_name: repo },
		commits: [{ id: sha(1), message: 'Again', timestamp: new Date().toISOString() }]
	});
	expect(again.status()).toBe(200);
	await ctx.close();
});

test('M9 a step refuses fake evidence with the reason, and accepts a commit GitHub knows that changed files', async ({
	browser,
	baseURL,
	request
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'owner@acme.example');
	const { key, repo, ref } = await setup(page, request);
	const record = (evidence: Record<string, unknown>, stepKey = '1.1') =>
		page.request.post(`${ACME}/items/${ref}/record`, {
			data: { marks: [{ key: stepKey, mark: 'done', evidence }] }
		});
	const refused = async (evidence: Record<string, unknown>, reason: RegExp) => {
		const res = await record(evidence);
		expect(res.status()).toBe(400);
		const body = await res.json();
		expect(body.error.message).toMatch(reason);
		expect(body.error.details).toMatchObject({ reason: 'evidence' });
	};
	await refused({ commit: 'f'.repeat(40) }, /not in the connected repository/);
	await refused({ commit: 'not-a-hash' }, /not a git hash/);
	await refused({ target: 'preview' }, /needs the checkRunId/);
	await refused({ checkRunId: '00000000-0000-4000-8000-000000000099' }, /no such check run/);
	// Nothing was recorded by any of those
	expect((await (await page.request.get(`${ACME}/items/${ref}`)).json()).item.doneSteps).toBe(0);
	// A commit that exists but changes no files is refused, one that changes files is accepted
	await control(request, 'commit', {
		repo,
		sha: 'e'.repeat(40),
		message: 'Empty commit',
		files: []
	});
	await control(request, 'commit', {
		repo,
		sha: 'd'.repeat(40),
		message: 'Real work',
		files: ['src/a.ts']
	});
	await refused({ commit: 'e'.repeat(40) }, /changes no files/);
	const ok = await record({ commit: 'd'.repeat(12), note: 'Checked by GitHub' });
	expect(ok.status()).toBe(200);
	expect((await ok.json()).changed).toEqual([{ key: '1.1', from: 'open', to: 'done' }]);
	// A step with no evidence needs none
	expect(
		(
			await page.request.post(`${ACME}/items/${ref}/record`, {
				data: { marks: [{ key: '1.2', mark: 'done' }] }
			})
		).status()
	).toBe(200);
	// The project without a repository cannot verify a commit at all, and says so
	const bare = `BR${tag}${++counter}`;
	await page.request.post(`${ACME}/projects`, { data: { key: bare, name: `Bare ${bare}` } });
	const bareItem = await (
		await page.request.post(`${ACME}/projects/${bare}/items`, {
			data: {
				title: 'No repository',
				phases: [{ key: '1', title: 'x', steps: [{ text: 'Only step' }] }]
			}
		})
	).json();
	const noRepo = await page.request.post(`${ACME}/items/${bareItem.ref}/record`, {
		data: { marks: [{ key: '1.1', mark: 'done', evidence: { commit: 'd'.repeat(12) } }] }
	});
	expect(noRepo.status()).toBe(400);
	expect((await noRepo.json()).error.message).toMatch(/no connected repository/);
	await page.goto(`/acme/${key}/${ref}`);
	await expect(page.getByTestId('item-percent')).toContainText('100%');
	await ctx.close();
});

test('M9 the health panel lists what needs attention and hides private items from people who may not see them', async ({
	browser,
	baseURL,
	request
}) => {
	const owner = await as(browser, baseURL!, 'owner@acme.example');
	const { key, repo, ref } = await setup(owner.page, request);
	const secret = await (
		await owner.page.request.post(`${ACME}/projects/${key}/items`, {
			data: {
				title: 'Private tracked work',
				visibility: 'private',
				phases: [{ key: '1', title: 'x', steps: [{ text: 'A step' }] }]
			}
		})
	).json();
	await webhook(request, 'push', {
		installation: { id: Number(INSTALL) },
		repository: { full_name: repo },
		commits: [
			{
				id: sha(3),
				message: `Public commit\n\nItem: ${ref}`,
				timestamp: new Date().toISOString(),
				modified: ['a.ts']
			},
			{
				id: sha(4),
				message: `Private commit\n\nItem: ${secret.ref}`,
				timestamp: new Date().toISOString(),
				modified: ['b.ts']
			}
		]
	});
	await owner.page.goto(`/acme/${key}/health`);
	await expect(owner.page.getByTestId('unrecorded-commit')).toHaveCount(2);
	// An item in review with a step open is drift, and says so in words
	await owner.page.request.post(`${ACME}/items/${ref}/record`, {
		data: { marks: [{ key: '1.1', mark: 'done' }] }
	});
	await owner.page.request.post(`${ACME}/items/${ref}/status`, {
		data: { status: 'IN REVIEW', note: 'Early review' }
	});
	await owner.page.reload();
	await expect(owner.page.getByTestId('drift-list')).toContainText('in review but a step is open');
	// A member sees the public commit only, and no publish or backup entries
	const member = await as(browser, baseURL!, 'member@acme.example');
	await member.page.goto(`/acme/${key}/health`);
	await expect(member.page.getByTestId('unrecorded-commit')).toHaveCount(0);
	await expect(member.page.getByTestId('publish-health')).toHaveCount(0);
	await expect(member.page.getByTestId('backup-health')).toHaveCount(0);
	expect(await member.page.content()).not.toContain(secret.ref);
	await member.ctx.close();
	await owner.ctx.close();
});

test('M9 a tool hook call over the API gives a brief, a title once, a close question and one stop reminder per code change', async ({
	browser,
	baseURL,
	request
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'owner@acme.example');
	const { key, ref } = await setup(page, request);
	await page.request.patch(`${ACME}/projects/${key}`, { data: { agentsMayComplete: true } });
	const other = await (
		await page.request.post(`${ACME}/projects/${key}/items`, {
			data: { title: 'Another item', phases: [] }
		})
	).json();
	const minted = await (
		await page.request.post(`${ACME}/tokens`, {
			data: { name: 'hook check', permissions: ['read', 'write', 'complete'] }
		})
	).json();
	const hook = async (body: Record<string, unknown>) =>
		(await (
			await request.post(`${ACME}/hooks`, {
				data: { tool: 'claude-code', externalId: 'hook-check-0001', ...body },
				headers: { authorization: `Bearer ${minted.token}` }
			})
		).json()) as Record<string, any>;
	const start = await hook({ event: 'start' });
	expect(start.context).toContain(ref);
	// Claim through MCP with the same token, and the tab title arrives on the next prompt, once
	const mcp = async (name: string, args: Record<string, unknown>) => {
		const res = await request.post('/mcp', {
			data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
			headers: {
				authorization: `Bearer ${minted.token}`,
				accept: 'application/json, text/event-stream'
			}
		});
		const r = await res.json();
		return r.result.structuredContent ?? JSON.parse(r.result.content[0].text);
	};
	// The brief hands out the hooks' own session id, and the tools use it, so the claim and the hooks belong together
	const sessionId = /Your session id is (s_[\w-]+)/.exec(start.context)![1];
	expect((await hook({ event: 'prompt' })).title).toBeUndefined();
	// A code change with no claim asks once to bind, and not again
	await hook({ event: 'tool', action: { kind: 'edit', file: 'src/a.ts' } });
	expect((await hook({ event: 'stop' })).block).toMatch(/works on no item/);
	expect(await hook({ event: 'stop' })).toEqual({});
	expect(await hook({ event: 'stop', stopActive: true })).toEqual({});
	// Claiming with that session id gives the tab title, once
	const claimed = await mcp('work_start', { sessionId, item: ref });
	expect(claimed.displayTitle).toMatch(new RegExp(`: ${ref}$`));
	const title = (await hook({ event: 'prompt' })).title;
	expect(title).toBe(claimed.displayTitle);
	expect(await hook({ event: 'prompt' })).toEqual({});
	// New code with nothing recorded earns one reminder naming the item, and a record ends it
	await new Promise((r) => setTimeout(r, 20));
	await hook({ event: 'tool', action: { kind: 'shell', command: 'git commit -m "work"' } });
	expect((await hook({ event: 'stop' })).block).toContain(
		`Code changed after the last record on ${ref}`
	);
	expect(await hook({ event: 'stop' })).toEqual({});
	await new Promise((r) => setTimeout(r, 20));
	await hook({ event: 'tool', action: { kind: 'edit', file: 'src/b.ts' } });
	await mcp('step_done', { sessionId, keys: ['1.1'] });
	expect(await hook({ event: 'stop' })).toEqual({});
	// A close of an item the session is not bound to is a question naming it, and the server asks the agent the same thing
	const ask = await hook({ event: 'closing', closing: [{ item: other.ref, status: 'COMPLETED' }] });
	expect(ask.ask).toContain(other.ref);
	expect(
		await hook({ event: 'closing', closing: [{ item: other.ref, status: 'IN REVIEW' }] })
	).toEqual({});
	const confirm = await mcp('item_status', {
		sessionId,
		item: other.ref,
		status: 'COMPLETED',
		note: 'Closing the other one'
	});
	expect(confirm.error.code).toBe('CONFIRM_REQUIRED');
	expect(confirm.error.message).toContain(other.ref);
	// A bad body is a plain 400, never a server error
	const bad = await request.post(`${ACME}/hooks`, {
		data: { tool: 'claude-code', externalId: 'x', event: 'start' },
		headers: { authorization: `Bearer ${minted.token}` }
	});
	expect(bad.status()).toBe(400);
	await ctx.close();
});
