// M3: a user in org A cannot see or change anything in org B through the UI, REST, MCP or an alias lookup, a removed member
// loses access on the next call, and a demoted user's token loses the higher permissions at once.
import { expect, request as pwRequest, test, type Browser, type Page } from '@playwright/test';
import { linkOf, mailsTo, mcp, newPerson, signIn } from './helpers';

const ACME = '/api/v1/orgs/acme';
const LUMORA = '/api/v1/orgs/lumora';

/** Signs in as the seed person in their own browser context. */
async function as(browser: Browser, baseURL: string, email: string) {
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await signIn(page, email);
	return { ctx, page };
}

/** Invites an address as a member, opens the mailed link as that person (already signed in), and accepts. */
async function inviteAndJoin(
	ownerPage: Page,
	person: Page,
	email: string,
	role: 'member' | 'viewer'
) {
	const sent = await ownerPage.request.post(`${ACME}/invites`, { data: { email, role } });
	expect(sent.status()).toBe(200);
	const mail = mailsTo(email).find((m) => m.subject.includes('invited you'))!;
	expect(mail).toBeTruthy();
	await person.goto(linkOf(mail));
	await person.getByRole('button', { name: /^Join / }).click();
	await expect(person.getByTestId('org-name')).toContainText('Acme');
}

test('M3 org A cannot see or change anything of org B through the UI, REST, MCP or an alias', async ({
	page,
	request,
	browser,
	baseURL
}) => {
	// Org B (Lumora) has an item with an old alias
	const lumora = await as(browser, baseURL!, 'owner@lumora.example');
	const made = await (
		await lumora.page.request.post(`${LUMORA}/projects/LUM/items`, {
			data: {
				title: 'Lumora secret launch plan',
				aliases: ['FLOW-LUMORA-ALIAS'],
				phases: [{ key: '1', title: 'One', steps: [{ text: 'Only step' }] }]
			}
		})
	).json();
	expect(made.ref).toMatch(/^LUM-/);

	// A person of org A (Acme)
	await signIn(page, 'member@acme.example');
	// UI: org B's pages are 404, never a hint that the org exists
	expect((await page.goto('/lumora'))!.status()).toBe(404);
	expect((await page.goto('/no-such-org-at-all'))!.status()).toBe(404);
	await page.goto('/');
	await expect(page.locator('body')).not.toContainText('Lumora');
	// REST by path and by name, as a session
	for (const path of [
		`${LUMORA}/projects`,
		`${LUMORA}/items/${made.ref}`,
		`${ACME}/items/${made.ref}`,
		`${ACME}/items/${made.id}`,
		`${ACME}/items/FLOW-LUMORA-ALIAS`
	]) {
		expect((await page.request.get(path)).status(), path).toBe(404);
	}
	expect(
		(
			await page.request.patch(`${ACME}/items/${made.id}`, {
				data: { title: 'Hijacked title here' }
			})
		).status()
	).toBe(404);
	expect(
		(
			await page.request.post(`${ACME}/items/${made.ref}/record`, {
				data: { marks: [{ key: '1.1', mark: 'done' }] }
			})
		).status()
	).toBe(404);
	expect(
		(
			await page.request.post(`${LUMORA}/projects/LUM/items`, {
				data: { title: 'Planted in the other org' }
			})
		).status()
	).toBe(404);
	// REST with a token minted in org A
	const minted = await (
		await page.request.post(`${ACME}/tokens`, {
			data: { name: 'tenant check', permissions: ['read', 'write'] }
		})
	).json();
	const agent = await pwRequest.newContext({
		baseURL,
		extraHTTPHeaders: { authorization: `Bearer ${minted.token}` }
	});
	expect((await agent.get(`${LUMORA}/projects`)).status()).toBe(404);
	expect((await agent.get(`${ACME}/items/${made.ref}`)).status()).toBe(404);
	// MCP with the same token: by reference, id, alias and search, and writes
	const client = mcp(request, minted.token);
	const s = await client.call('session_start', { tool: 'tenant-check' });
	for (const item of [made.ref, made.id, 'FLOW-LUMORA-ALIAS'])
		expect((await client.call('item_get', { item })).error.code, item).toBe('NOT_FOUND');
	expect(
		(await client.call('work_start', { sessionId: s.sessionId, item: made.ref })).error.code
	).toBe('NOT_FOUND');
	expect(
		(await client.call('step_done', { sessionId: s.sessionId, item: made.id, keys: ['1.1'] })).error
			.code
	).toBe('NOT_FOUND');
	expect((await client.call('search', { q: 'Lumora secret launch plan' })).hits).toEqual([]);
	expect((await client.call('flow_get', { id: 'FLOW-LUMORA-ALIAS' })).error.code).toBe('NOT_FOUND');
	// The other way round: a Lumora token cannot reach Acme
	const lToken = await (
		await lumora.page.request.post(`${LUMORA}/tokens`, {
			data: { name: 'lumora token', permissions: ['read', 'write'] }
		})
	).json();
	const lAgent = await pwRequest.newContext({
		baseURL,
		extraHTTPHeaders: { authorization: `Bearer ${lToken.token}` }
	});
	expect((await lAgent.get(`${ACME}/projects`)).status()).toBe(404);
	// Nothing changed in org B
	const still = await (await lumora.page.request.get(`${LUMORA}/items/${made.ref}`)).json();
	expect(still.item.status).toBe('PLANNED');
	expect(still.item.title).toBe('Lumora secret launch plan');
	await agent.dispose();
	await lAgent.dispose();
	await lumora.ctx.close();
});

test('M3 a removed member loses access on the next call, in the UI, REST and MCP', async ({
	browser,
	baseURL,
	request
}) => {
	const owner = await as(browser, baseURL!, 'owner@acme.example');
	const newbie = await browser.newContext({ baseURL });
	const np = await newbie.newPage();
	const email = await newPerson(np, 'removed');
	await inviteAndJoin(owner.page, np, email, 'member');
	const me = await (await np.request.get('/api/v1/me')).json();
	const minted = await (
		await np.request.post(`${ACME}/tokens`, {
			data: { name: 'soon removed', permissions: ['read', 'write'] }
		})
	).json();
	const client = mcp(request, minted.token);
	const s = await client.call('session_start', { tool: 'soon-removed' });
	expect(
		(
			await client.call('item_new', {
				sessionId: s.sessionId,
				project: 'CKT',
				title: 'Made before removal',
				phases: []
			})
		).ref
	).toMatch(/^CKT-/);
	expect((await np.request.get(`${ACME}/projects`)).status()).toBe(200);
	// The owner removes them
	expect((await owner.page.request.delete(`${ACME}/members/${me.userId}`)).status()).toBe(200);
	// The very next call fails everywhere
	expect((await np.request.get(`${ACME}/projects`)).status()).toBe(404);
	expect((await np.goto('/acme'))!.status()).toBe(404);
	expect(
		(
			await request.get(`${ACME}/projects`, {
				headers: { authorization: `Bearer ${minted.token}` }
			})
		).status()
	).toBe(401);
	expect(
		(
			await request.post('/mcp', {
				data: { jsonrpc: '2.0', id: 9, method: 'tools/list' },
				headers: { authorization: `Bearer ${minted.token}` }
			})
		).status()
	).toBe(401);
	await newbie.close();
	await owner.ctx.close();
});

test('M3 a demoted member keeps the token but loses write at once, and read keeps working', async ({
	browser,
	baseURL,
	request
}) => {
	const owner = await as(browser, baseURL!, 'owner@acme.example');
	const demo = await browser.newContext({ baseURL });
	const dp = await demo.newPage();
	const email = await newPerson(dp, 'demoted');
	await inviteAndJoin(owner.page, dp, email, 'member');
	const me = await (await dp.request.get('/api/v1/me')).json();
	const minted = await (
		await dp.request.post(`${ACME}/tokens`, {
			data: { name: 'soon demoted', permissions: ['read', 'write', 'complete'] }
		})
	).json();
	const client = mcp(request, minted.token);
	const s = await client.call('session_start', { tool: 'soon-demoted' });
	const made = await client.call('item_new', {
		sessionId: s.sessionId,
		project: 'CKT',
		title: 'Made before demotion',
		phases: [{ key: '1', title: 'One', steps: [{ text: 'a' }, { text: 'b' }] }]
	});
	expect(
		(await client.call('step_done', { sessionId: s.sessionId, item: made.ref, keys: ['1.1'] }))
			.changed[0].to
	).toBe('done');
	// The owner makes them a viewer
	expect(
		(
			await owner.page.request.patch(`${ACME}/members/${me.userId}`, { data: { role: 'viewer' } })
		).status()
	).toBe(200);
	// Writes stop at once, with the same token, and reads still work
	expect(
		(await client.call('step_done', { sessionId: s.sessionId, item: made.ref, keys: ['1.2'] }))
			.error.code
	).toBe('FORBIDDEN');
	expect(
		(
			await client.call('item_new', {
				sessionId: s.sessionId,
				project: 'CKT',
				title: 'After demotion',
				phases: []
			})
		).error.code
	).toBe('FORBIDDEN');
	expect((await client.call('item_get', { item: made.ref })).ref).toBe(made.ref);
	const rest = await request.post(`${ACME}/items/${made.ref}/record`, {
		data: { marks: [{ key: '1.2', mark: 'done' }] },
		headers: { authorization: `Bearer ${minted.token}` }
	});
	expect(rest.status()).toBe(403);
	expect(
		(
			await request.get(`${ACME}/items/${made.ref}`, {
				headers: { authorization: `Bearer ${minted.token}` }
			})
		).status()
	).toBe(200);
	// A viewer cannot mint a token with write either
	expect(
		(
			await dp.request.post(`${ACME}/tokens`, {
				data: { name: 'greedy', permissions: ['read', 'write'] }
			})
		).status()
	).toBe(403);
	await demo.close();
	await owner.ctx.close();
});
