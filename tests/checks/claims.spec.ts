/* eslint-disable @typescript-eslint/no-explicit-any -- tool and API replies are parsed from JSON and read loosely in checks */
// M19: a finished phase moves the claim to the next phase, a claim with no phase shows Running at item level, a close clears every
// claim on the item and the holder is told, and closing an item the session is not bound to answers CONFIRM_REQUIRED until
// confirmed. Two agent sessions of two tools work on the same project; a person watches the board.
import { expect, test, type APIRequestContext, type Browser } from '@playwright/test';
import { signIn } from './helpers';

const ACME = '/api/v1/orgs/acme';
const tag = Date.now().toString(36).toUpperCase().slice(-5);
let counter = 0;

async function as(browser: Browser, baseURL: string, email: string) {
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await signIn(page, email);
	return { ctx, page };
}

/** A tiny MCP client with its own token. */
function agentOf(request: APIRequestContext, token: string) {
	let id = 0;
	return async (name: string, args: Record<string, unknown> = {}) => {
		const res = await request.post('/mcp', {
			data: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } },
			headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' }
		});
		const r = await res.json();
		return (r.result.structuredContent ?? JSON.parse(r.result.content[0].text)) as Record<
			string,
			any
		>;
	};
}

test('M19 a finished phase moves the claim, a claim with no phase is item level, and the board shows both live', async ({
	browser,
	baseURL,
	request
}) => {
	const owner = await as(browser, baseURL!, 'owner@acme.example');
	const key = `CL${tag}${++counter}`;
	await owner.page.request.post(`${ACME}/projects`, { data: { key, name: `Claims ${key}` } });
	const phased = await (
		await owner.page.request.post(`${ACME}/projects/${key}/items`, {
			data: {
				title: 'Two phase item',
				phases: [
					{ key: '1', title: 'One', steps: [{ text: 'A' }, { text: 'B' }] },
					{ key: '2', title: 'Two', steps: [{ text: 'C' }] }
				]
			}
		})
	).json();
	const bare = await (
		await owner.page.request.post(`${ACME}/projects/${key}/items`, {
			data: { title: 'Item with no phases', phases: [] }
		})
	).json();
	const tokenA = (
		await (
			await owner.page.request.post(`${ACME}/tokens`, {
				data: { name: 'claude', permissions: ['read', 'write'] }
			})
		).json()
	).token;
	const tokenB = (
		await (
			await owner.page.request.post(`${ACME}/tokens`, {
				data: { name: 'agy', permissions: ['read', 'write'] }
			})
		).json()
	).token;
	const a = agentOf(request, tokenA);
	const b = agentOf(request, tokenB);
	const watcher = await as(browser, baseURL!, 'member@acme.example');
	await watcher.page.goto(`/acme/${key}/${phased.ref}`);
	await watcher.page.waitForTimeout(400);

	const sa = (await a('session_start', { tool: 'Claude Code' })).sessionId;
	const sb = (await b('session_start', { tool: 'Antigravity' })).sessionId;
	const claimed = await a('work_start', { sessionId: sa, item: phased.ref, phase: '1' });
	expect(claimed.phase).toBe('1');
	await expect(watcher.page.getByText('Phase 1, Claude Code').first()).toBeVisible({
		timeout: 3000
	});
	// Finishing the first phase moves the claim to the second, and the reply names it
	await a('step_done', { sessionId: sa, keys: ['1.1'] });
	const moved = await a('step_done', { sessionId: sa, keys: ['1.2'] });
	expect(moved.finishedPhases).toEqual(['1']);
	expect(moved.nextPhase).toBe('2');
	expect(moved.claim).toEqual({ item: phased.id, phase: '2', moved: true });
	await expect(watcher.page.getByText('Phase 2, Claude Code').first()).toBeVisible({
		timeout: 3000
	});
	await expect(watcher.page.getByText('Phase 1, Claude Code')).toHaveCount(0);
	// A claim with no phase shows the item as Running at item level, with the tool and the title
	await b('work_start', { sessionId: sb, item: bare.ref });
	await watcher.page.goto(`/acme/${key}`);
	const running = watcher.page.getByTestId('running-now');
	await expect(running).toContainText(`: ${bare.ref}`);
	await expect(running.getByText(/Running, Antigravity/)).toBeVisible();
	await expect(running.getByText(/Phase 2, Claude Code/)).toBeVisible();
	await watcher.ctx.close();
	await owner.ctx.close();
});

test('M19 a close clears every claim on the item, tells each holder once, and closing another item asks first', async ({
	browser,
	baseURL,
	request
}) => {
	const owner = await as(browser, baseURL!, 'owner@acme.example');
	const key = `CC${tag}${++counter}`;
	await owner.page.request.post(`${ACME}/projects`, { data: { key, name: `Closing ${key}` } });
	await owner.page.request.patch(`${ACME}/projects/${key}`, { data: { agentsMayComplete: true } });
	const make = async (title: string) =>
		(await (
			await owner.page.request.post(`${ACME}/projects/${key}/items`, {
				data: { title, phases: [{ key: '1', title: 'x', steps: [{ text: 'Only step' }] }] }
			})
		).json()) as { ref: string; id: string };
	const shared = await make('Shared by two sessions');
	const mine = await make('Held by the first session');
	const elsewhere = await make('Some other item');
	for (const it of [shared, mine, elsewhere])
		await owner.page.request.post(`${ACME}/items/${it.ref}/record`, {
			data: { marks: [{ key: '1.1', mark: 'done' }] }
		});
	const tokenA = (
		await (
			await owner.page.request.post(`${ACME}/tokens`, {
				data: { name: 'claude', permissions: ['read', 'write', 'complete'] }
			})
		).json()
	).token;
	const tokenB = (
		await (
			await owner.page.request.post(`${ACME}/tokens`, {
				data: { name: 'agy', permissions: ['read', 'write', 'complete'] }
			})
		).json()
	).token;
	const a = agentOf(request, tokenA);
	const b = agentOf(request, tokenB);
	const sa = (await a('session_start', { tool: 'Claude Code' })).sessionId;
	const sb = (await b('session_start', { tool: 'Antigravity' })).sessionId;
	await a('work_start', { sessionId: sa, item: shared.ref, phase: '1' });
	await b('work_start', { sessionId: sb, item: shared.ref });
	const watcher = await as(browser, baseURL!, 'member@acme.example');
	await watcher.page.goto(`/acme/${key}`);
	await expect(watcher.page.getByTestId('running-now')).toContainText('Claude Code');
	await expect(watcher.page.getByTestId('running-now')).toContainText('Antigravity');
	// A person closes the item from the board: no question, and every claim on it ends at once
	const closed = await owner.page.request.post(`${ACME}/items/${shared.ref}/status`, {
		data: { status: 'COMPLETED', note: 'Signed off by a person' }
	});
	expect(closed.status()).toBe(200);
	await expect(watcher.page.getByTestId('running-now')).toHaveCount(0, { timeout: 3000 });
	// Each holder is told in its next reply, once
	const reply = await a('item_get', { sessionId: sa, item: shared.ref });
	expect(reply.notes.join(' ')).toContain(
		`${shared.ref} was set to COMPLETED, so your claim on it was released`
	);
	expect((await a('item_get', { sessionId: sa, item: shared.ref })).notes).toBeUndefined();
	const replyB = await b('item_get', { sessionId: sb, item: shared.ref });
	expect(replyB.notes.join(' ')).toContain('your claim on it was released');
	// An agent closing an item it is not bound to is asked, naming both, and repeats with confirmed
	await a('work_start', { sessionId: sa, item: mine.ref, phase: '1' });
	const ask = await a('item_status', {
		sessionId: sa,
		item: elsewhere.ref,
		status: 'COMPLETED',
		note: 'Done somewhere else'
	});
	expect(ask.error.code).toBe('CONFIRM_REQUIRED');
	expect(ask.error.message).toContain(mine.ref);
	expect(ask.error.message).toContain(elsewhere.ref);
	expect(ask.error.details).toMatchObject({
		closing: { ref: elsewhere.ref },
		bound: { ref: mine.ref }
	});
	expect(
		(await owner.page.request.get(`${ACME}/items/${elsewhere.ref}`).then((r) => r.json())).item
			.status
	).not.toBe('COMPLETED');
	const confirmed = await a('item_status', {
		sessionId: sa,
		item: elsewhere.ref,
		status: 'COMPLETED',
		note: 'Done somewhere else',
		confirmed: true
	});
	expect(confirmed.statusChanges[0].to).toBe('COMPLETED');
	// The item it is bound to closes with no question, and the claim goes with it
	const own = await a('item_status', {
		sessionId: sa,
		item: mine.ref,
		status: 'COMPLETED',
		note: 'My own item'
	});
	expect(own.statusChanges[0].to).toBe('COMPLETED');
	await watcher.page.goto(`/acme/${key}`);
	await expect(watcher.page.getByTestId('running-now')).toHaveCount(0);
	await watcher.ctx.close();
	await owner.ctx.close();
});
