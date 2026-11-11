/* eslint-disable @typescript-eslint/no-explicit-any -- tool and API replies are parsed from JSON and read loosely in checks */
// M9: the hook endpoint the bridge calls.
import { expect, test, type Browser, type Page } from '@playwright/test';
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
/** A project and an item with two steps. */
async function setup(page: Page) {
	const key = `TR${tag}${++counter}`;
	expect(
		(
			await page.request.post(`${ACME}/projects`, { data: { key, name: `Tracking ${key}` } })
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
	return { key, ref: made.ref as string, id: made.id as string };
}

test('M9 a tool hook call over the API gives a brief, a title once, a close question and one stop reminder per code change', async ({
	browser,
	baseURL,
	request
}) => {
	const { ctx, page } = await as(browser, baseURL!, 'owner@acme.example');
	const { key, ref } = await setup(page);
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
