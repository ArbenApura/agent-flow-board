// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { guardContext } from './guard.js';
import type { RouteLike } from './guard.js';

// -- CONSTANTS -- //

const ORIGIN = 'http://127.0.0.1:4173';

// -- FUNCTIONS -- //

/** A route that records what the guard did with it. */
function fakeRoute(url: string, method = 'GET', type = 'fetch') {
	const calls: string[] = [];
	const route: RouteLike = {
		request: () => ({ url: () => url, method: () => method, resourceType: () => type }),
		continue: async () => void calls.push('continue'),
		abort: async () => void calls.push('abort'),
		fulfill: async (o) => void calls.push(`fulfill ${o.status}`)
	};
	return { route, calls };
}

async function setup(options: { allowWrites?: boolean; extraHosts?: string[] } = {}) {
	let handler: (route: RouteLike) => void | Promise<void> = () => {};
	const blocked: string[] = [];
	const counts = await guardContext(
		{ route: async (_pattern, h) => void (handler = h) },
		{ origin: ORIGIN, onBlocked: (m) => void blocked.push(m), ...options }
	);
	const run = async (url: string, method?: string, type?: string) => {
		const r = fakeRoute(url, method, type);
		await handler(r.route);
		return r.calls;
	};
	return { counts, blocked, run };
}

describe('guardContext', () => {
	it('lets reads of the app through', async () => {
		const { run, counts } = await setup();
		expect(await run(`${ORIGIN}/a`)).toEqual(['continue']);
		expect(await run(`${ORIGIN}/a`, 'HEAD')).toEqual(['continue']);
		expect(counts).toEqual({ writes: 0, outside: 0 });
	});

	it('lets data and blob urls through', async () => {
		const { run } = await setup();
		expect(await run('data:text/plain,hi')).toEqual(['continue']);
		expect(await run('blob:http://x/1')).toEqual(['continue']);
	});

	it('aborts a request outside the origin and counts it', async () => {
		const { run, counts, blocked } = await setup();
		expect(await run('https://evil.example.com/steal')).toEqual(['abort']);
		expect(counts.outside).toBe(1);
		expect(blocked[0]).toContain('evil.example.com');
	});

	it('lets an extra host through', async () => {
		const { run, counts } = await setup({ extraHosts: ['cdn.example.com'] });
		expect(await run('https://cdn.example.com/x.js')).toEqual(['continue']);
		expect(counts.outside).toBe(0);
	});

	it('stops a write: a form post is answered with 204, a fetch is aborted', async () => {
		const { run, counts } = await setup();
		expect(await run(`${ORIGIN}/save`, 'POST', 'document')).toEqual(['fulfill 204']);
		expect(await run(`${ORIGIN}/api`, 'DELETE', 'fetch')).toEqual(['abort']);
		expect(counts.writes).toBe(2);
	});

	it('lets writes through when allowed', async () => {
		const { run, counts } = await setup({ allowWrites: true });
		expect(await run(`${ORIGIN}/save`, 'POST')).toEqual(['continue']);
		expect(counts.writes).toBe(0);
	});
});

describe('write policy and WebSocket guard', () => {
	it('stops every non-GET HTTP method by default and counts each blocked write', async () => {
		let httpHandler: ((r: unknown) => Promise<void>) | undefined;
		const ctx = {
			route: async (_u: string, h: (r: unknown) => Promise<void>) => {
				httpHandler = h;
			}
		};
		const notes: string[] = [];
		const counts = await guardContext(ctx as never, {
			origin: 'http://localhost:5173',
			onBlocked: (m) => notes.push(m)
		});
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			let aborted = false;
			let continued = false;
			await httpHandler!({
				request: () => ({
					url: () => 'http://localhost:5173/api/item',
					method: () => method,
					resourceType: () => 'fetch'
				}),
				abort: async () => {
					aborted = true;
				},
				continue: async () => {
					continued = true;
				},
				fulfill: async () => {}
			});
			expect(aborted).toBe(true);
			expect(continued).toBe(false);
		}
		expect(counts.writes).toBe(4);
		expect(notes).toHaveLength(4);
	});

	it('allows only allowlisted method+path patterns on same origin and stops writes outside the list', async () => {
		let httpHandler: ((r: unknown) => Promise<void>) | undefined;
		const ctx = {
			route: async (_u: string, h: (r: unknown) => Promise<void>) => {
				httpHandler = h;
			}
		};
		const counts = await guardContext(ctx as never, {
			origin: 'http://localhost:5173',
			allowWrites: true,
			writeAllowlist: [{ method: 'POST', pathPrefix: '/api/drafts' }]
		});

		const runReq = async (url: string, method: string) => {
			let passed = false;
			await httpHandler!({
				request: () => ({ url: () => url, method: () => method, resourceType: () => 'fetch' }),
				abort: async () => {},
				continue: async () => {
					passed = true;
				},
				fulfill: async () => {}
			});
			return passed;
		};

		expect(await runReq('http://localhost:5173/api/drafts/42', 'POST')).toBe(true);
		expect(await runReq('http://localhost:5173/api/drafts/42', 'DELETE')).toBe(false);
		expect(await runReq('http://localhost:5173/api/admin', 'POST')).toBe(false);
		expect(await runReq('https://evil.example/api/drafts/42', 'POST')).toBe(false);
		expect(counts).toEqual({ writes: 2, outside: 1 });
	});

	it('routes WebSockets through the origin and write guard', async () => {
		let wsHandler: ((ws: unknown) => void) | undefined;
		const ctx = {
			route: async () => {},
			routeWebSocket: async (_u: string, h: (ws: unknown) => void) => {
				wsHandler = h;
			}
		};
		const counts = await guardContext(ctx as never, { origin: 'http://localhost:5173' });

		let closedOutside = false;
		wsHandler!({
			url: () => 'wss://evil.example/ws',
			close: () => {
				closedOutside = true;
			}
		});
		expect(closedOutside).toBe(true);
		expect(counts.outside).toBe(1);

		const forwarded: unknown[] = [];
		let clientMsgHandler: ((m: string) => void) | undefined;
		wsHandler!({
			url: () => 'ws://localhost:5173/ws',
			close: () => {},
			onMessage: (h: (m: string) => void) => {
				clientMsgHandler = h;
			},
			connectToServer: () => ({
				onMessage: () => {},
				send: (m: unknown) => forwarded.push(m)
			})
		});
		clientMsgHandler!('{"action":"mutate"}');
		expect(forwarded).toHaveLength(0);
		expect(counts.writes).toBe(1);

		// Query-string / extra-field spoofs must NEVER bypass the write guard
		clientMsgHandler!('{"type":"ping","mutation":true}');
		expect(forwarded).toHaveLength(0);
		expect(counts.writes).toBe(2);

		let spoofWsHandler: ((m: string) => void) | undefined;
		wsHandler!({
			url: () => 'ws://localhost:5173/api/mutate?vite-hmr=1',
			close: () => {},
			onMessage: (h: (m: string) => void) => {
				spoofWsHandler = h;
			},
			connectToServer: () => ({
				onMessage: () => {},
				send: (m: unknown) => forwarded.push(m)
			})
		});
		spoofWsHandler!('{"type":"ping"}');
		spoofWsHandler!('{"evil":1}');
		expect(forwarded).toHaveLength(0);
		expect(counts.writes).toBe(4);

		// Only exact {"type":"ping"} on the local Vite HMR path is exempt
		let viteHandler: ((m: string) => void) | undefined;
		wsHandler!({
			url: () => 'ws://localhost:5173/',
			close: () => {},
			onMessage: (h: (m: string) => void) => {
				viteHandler = h;
			},
			connectToServer: () => ({
				onMessage: () => {},
				send: (m: unknown) => forwarded.push(m)
			})
		});
		viteHandler!('{"type":"ping"}');
		expect(forwarded).toEqual(['{"type":"ping"}']);
	});
});
