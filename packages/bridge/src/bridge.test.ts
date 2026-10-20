/* eslint-disable @typescript-eslint/no-explicit-any -- tool replies are parsed from JSON and read loosely in tests */
// 6.9: THE STDIO BRIDGE END TO END AGAINST THE REAL /mcp HANDLER, WITH THE OFFLINE QUEUE, THE DEVICE SIGN IN AND THE TOKEN STORE

// -- DEP-MODULES -- //
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { memoryStorage } from '../../../src/lib/server/adapters/storage';
import { handleMcp } from '../../../src/lib/server/mcp/handler';
import { approveDevice, pollDevice, startDevice } from '../../../src/lib/server/oauth/oauth';
import { createToken } from '../../../src/lib/server/ops/tokens';
import { makePostgres, type TestDb } from '../../../tests/support/db';
import { makeWorld, type World } from '../../../tests/support/ops';
import { runBridge } from './bridge';
import { deviceLogin, type Fetch } from './device';
import { Queue } from './queue';
import { accountKey, fileStore, windowsStore } from './tokenStore';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';

// -- FUNCTIONS -- //

describe('bridge', () => {
	let db: TestDb;
	let w: World;
	let token: string;
	let dir: string;
	const deps = () => ({
		handle: db,
		storage: memoryStorage('bridge-storage-secret-0123456789abc'),
		baseUrl: BASE
	});
	/** A fetch that goes straight into the real handler, and can be switched off or tampered with. */
	const shim =
		(state: { offline?: boolean; protocol?: string } = {}): Fetch =>
		async (input, init) => {
			if (state.offline) throw new TypeError('fetch failed');
			// The address /mcp/<slug> names the organisation, as the real route does
			const slug = /\/mcp\/([^/?]+)/.exec(String(input))?.[1];
			const res = await handleMcp(new Request(input, init), deps(), slug);
			if (!state.protocol) return res;
			const h = new Headers(res.headers);
			h.set('x-afb-protocol', state.protocol);
			return new Response(res.body, { status: res.status, headers: h });
		};

	beforeAll(async () => {
		db = await makePostgres();
		w = await makeWorld(db);
		token = (
			await createToken(w.ctx('member'), {
				name: 'bridge',
				permissions: ['read', 'comment', 'write', 'complete', 'delete']
			})
		).token;
		dir = mkdtempSync(join(tmpdir(), 'afb-bridge-'));
	}, 120_000);
	afterAll(async () => {
		await db.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	/** Runs the bridge on a pair of streams and returns helpers to send lines and read replies. */
	function start(options: {
		fetch: Fetch;
		token?: string | null;
		login?: () => Promise<string>;
		queue?: Queue;
		org?: string;
	}) {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const lines: any[] = [];
		const logs: string[] = [];
		let buf = '';
		stdout.on('data', (c) => {
			buf += c.toString();
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				lines.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
			}
		});
		const queue =
			options.queue ?? new Queue(join(dir, `queue-${Math.random().toString(36).slice(2)}.json`));
		const done = runBridge({
			server: BASE,
			org: options.org,
			fetch: options.fetch,
			getToken: () => (options.token === undefined ? token : options.token),
			login: options.login ?? (async () => token),
			queue,
			stdin,
			stdout,
			log: (l) => logs.push(l),
			replayEveryMs: 0
		});
		let id = 0;
		const rpc = async (method: string, params?: unknown): Promise<any> => {
			const mine = ++id;
			stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n');
			for (let i = 0; i < 400; i++) {
				const hit = lines.find((l) => l.id === mine);
				if (hit) return hit;
				await new Promise((r) => setTimeout(r, 10));
			}
			throw new Error(`No reply to ${method}`);
		};
		const tool = async (name: string, args: Record<string, unknown> = {}) => {
			const r = await rpc('tools/call', { name, arguments: args });
			return { raw: r, out: (r.result?.structuredContent ?? null) as any };
		};
		return {
			rpc,
			tool,
			logs,
			queue,
			lines,
			end: async () => {
				stdin.end();
				await done;
			}
		};
	}

	const init = async (b: ReturnType<typeof start>) => {
		await b.rpc('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'bridge-test', version: '1' }
		});
		await b.rpc('tools/list');
	};

	it('forwards a whole conversation to the server and holds no tool code of its own', async () => {
		const b = start({ fetch: shim() });
		const hello = await b.rpc('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'bridge-test', version: '1' }
		});
		expect(hello.result.serverInfo.name).toBe('agent-flow-board');
		expect(hello.result.instructions).toContain('session_start');
		const tools = await b.rpc('tools/list');
		expect(tools.result.tools.map((t: any) => t.name)).toContain('step_done');
		const s = await b.tool('session_start', { tool: 'bridge' });
		expect(s.out.sessionId).toMatch(/^s_/);
		const made = await b.tool('item_new', {
			sessionId: s.out.sessionId,
			project: w.projectKey,
			title: 'Made through the bridge',
			phases: [{ key: '1', title: 'One', steps: [{ text: 'a' }] }]
		});
		expect(made.out.ref).toMatch(/^WRL/);
		expect(b.logs).toEqual([]);
		await b.end();
	});

	it('with an organisation it talks to /mcp/<slug>, and another organisation is refused without a login loop', async () => {
		const [{ slug }] = await db.admin.query<{ slug: string }>(
			`select slug from org where id = '${w.orgId}'`
		);
		const own = start({ fetch: shim(), org: slug });
		const hello = await own.rpc('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'bridge-test', version: '1' }
		});
		expect(hello.result.instructions).toContain(`afb-${slug}`);
		await own.end();
		let logins = 0;
		const wrong = start({
			fetch: shim(),
			org: 'some-other-org',
			login: async () => (logins++, token)
		});
		const refused = await wrong.rpc('initialize', {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'bridge-test', version: '1' }
		});
		expect(refused.error.message).toContain('FORBIDDEN');
		expect(logins).toBe(0);
		await wrong.end();
	});

	it('keeps a sign in per server and organisation, and the plain host key when no organisation is given', () => {
		expect(accountKey('https://board.example.com')).toBe('board.example.com');
		expect(accountKey('https://board.example.com', 'arbenger')).toBe('board.example.com/arbenger');
		expect(accountKey('https://board.example.com', 'arbenger')).not.toBe(
			accountKey('https://board.example.com', 'mangoman')
		);
		const store = fileStore(mkdtempSync(join(dir, 'keys-')));
		store.set(accountKey('https://board.example.com', 'arbenger'), 'a');
		store.set(accountKey('https://board.example.com', 'mangoman'), 'b');
		expect(store.get(accountKey('https://board.example.com', 'arbenger'))).toBe('a');
		expect(store.get(accountKey('https://board.example.com', 'mangoman'))).toBe('b');
		store.delete(accountKey('https://board.example.com', 'arbenger'));
		expect(store.get(accountKey('https://board.example.com', 'arbenger'))).toBeNull();
		expect(store.get(accountKey('https://board.example.com', 'mangoman'))).toBe('b');
	});

	it('warns once when the server speaks a newer protocol than the bridge', async () => {
		const b = start({ fetch: shim({ protocol: '9' }) });
		await init(b);
		await b.rpc('tools/list');
		expect(b.logs.filter((l) => l.includes('protocol 9'))).toHaveLength(1);
		expect(b.logs[0]).toContain('npx -y @agent-flow-board/bridge@latest');
		await b.end();
	});

	it('signs in again once when the saved token is refused, then carries on', async () => {
		let logins = 0;
		const b = start({ fetch: shim(), token: 'afb_expired', login: async () => (logins++, token) });
		await init(b);
		expect(logins).toBe(1);
		expect(b.logs.some((l) => l.includes('Signing in again'))).toBe(true);
		expect((await b.tool('session_start', { tool: 'bridge' })).out.sessionId).toMatch(/^s_/);
		await b.end();
	});

	it('offline: a read says so, a write is queued and says so, nothing is made up', async () => {
		const state = { offline: false };
		const b = start({ fetch: shim(state) });
		await init(b);
		state.offline = true;
		const read = await b.rpc('tools/call', { name: 'item_get', arguments: { item: 'X-1' } });
		expect(read.error.message).toContain('offline');
		const write = await b.tool('task_new', {
			sessionId: 's_x',
			project: w.projectKey,
			title: 'Queued while offline'
		});
		expect(write.out.queued).toBe(true);
		expect(write.out.queueId).toMatch(/^q/);
		expect(write.out.nextOpen).toBeUndefined();
		expect(write.out.percent).toBeUndefined();
		expect(b.queue.list()).toHaveLength(1);
		expect(b.queue.list()[0].args.requestId).toMatch(/^afb-q/);
		await b.end();
	});

	it('replays in order when the board is back, holding later writes for an item whose write was refused', async () => {
		const state = { offline: false };
		const queue = new Queue(join(dir, 'replay.json'));
		const b = start({ fetch: shim(state), queue });
		await init(b);
		const s = await b.tool('session_start', { tool: 'bridge' });
		const a = await b.tool('item_new', {
			sessionId: s.out.sessionId,
			project: w.projectKey,
			title: 'Replay item A'
		});
		const c = await b.tool('item_new', {
			sessionId: s.out.sessionId,
			project: w.projectKey,
			title: 'Replay item B'
		});
		state.offline = true;
		// Item A: a write that will be refused (a stale version), then one that depends on it. Item B: a good write.
		const q1 = await b.tool('item_update', {
			sessionId: s.out.sessionId,
			item: a.out.ref,
			title: 'Stale rename',
			expectVersion: 999
		});
		const q2 = await b.tool('item_update', {
			sessionId: s.out.sessionId,
			item: a.out.ref,
			branchNote: 'depends on the first'
		});
		const q3 = await b.tool('item_update', {
			sessionId: s.out.sessionId,
			item: c.out.ref,
			title: 'Item B renamed offline'
		});
		expect([q1.out.queued, q2.out.queued, q3.out.queued]).toEqual([true, true, true]);
		state.offline = false;
		// Any successful call triggers a replay
		await b.rpc('tools/list');
		for (let i = 0; i < 100 && queue.list().some((e) => e.key === c.out.ref); i++)
			await new Promise((r) => setTimeout(r, 20));
		const left = queue.list();
		expect(left.some((e) => e.key === c.out.ref)).toBe(false);
		const heldA = left.filter((e) => e.key === a.out.ref);
		expect(heldA).toHaveLength(2);
		expect(heldA[0].state).toBe('held');
		expect(heldA[0].reason).toContain('changed by someone else');
		const got = await b.tool('item_get', { item: c.out.ref });
		expect(got.out.title).toBe('Item B renamed offline');
		const untouched = await b.tool('item_get', { item: a.out.ref });
		expect(untouched.out.title).toBe('Replay item A');
		// The person can retry or drop a held write
		expect(queue.drop(heldA[1].id)).toBe(true);
		expect(queue.retry(heldA[0].id)).toBe(true);
		expect(queue.list()[0].state).toBe('queued');
		await b.end();
	});

	it('the device sign in works against the real endpoints, and reports a refusal', async () => {
		const logs: string[] = [];
		const fetchImpl: Fetch = async (input, init) => {
			const url = new URL(input);
			const body = init?.body ? (typeof init.body === 'string' ? init.body : '') : '';
			const json = (v: unknown, status = 200) =>
				new Response(JSON.stringify(v), {
					status,
					headers: { 'content-type': 'application/json' }
				});
			if (url.pathname === '/oauth/device/code')
				return json(await startDevice(db, BASE, JSON.parse(body)));
			if (url.pathname === '/oauth/token')
				return json(await pollDevice(db, new URLSearchParams(body).get('device_code')!));
			return new Response('no', { status: 404 });
		};
		const wait = async () => {
			// The person types the code while the bridge waits
			const code = logs
				.find((l) => l.includes('type this code'))
				?.split(': ')
				.pop();
			if (code && !approved) {
				approved = true;
				await approveDevice(db, {
					userId: w.people.member,
					typed: code,
					orgId: w.orgId,
					scopes: ['read', 'write']
				});
			}
			await db.admin.exec('update device_code set last_polled_at = null');
		};
		let approved = false;
		const r = await deviceLogin(BASE, fetchImpl, (l) => logs.push(l), { wait });
		expect(r.token).toMatch(/^afb_/);
		expect(logs[0]).toContain(`${BASE}/device`);
		let denied = false;
		const logs2: string[] = [];
		await expect(
			deviceLogin(BASE, fetchImpl, (l) => logs2.push(l), {
				wait: async () => {
					const code = logs2
						.find((l) => l.includes('type this code'))
						?.split(': ')
						.pop();
					if (code && !denied) {
						denied = true;
						await approveDevice(db, {
							userId: w.people.member,
							typed: code,
							orgId: w.orgId,
							scopes: [],
							deny: true
						});
					}
					await db.admin.exec('update device_code set last_polled_at = null');
				}
			})
		).rejects.toThrow(/refused/);
	});

	it('the file token store encrypts, keeps the key private, and gives up cleanly on a tampered file', () => {
		const home = mkdtempSync(join(tmpdir(), 'afb-store-'));
		const store = fileStore(home);
		expect(store.get('board.example.com')).toBeNull();
		store.set('board.example.com', 'afb_secret_token_value');
		expect(store.get('board.example.com')).toBe('afb_secret_token_value');
		const file = join(home, 'token-board.example.com.enc');
		expect(statSync(file).size).toBeGreaterThan(28);
		expect(require_file_text(file)).not.toContain('afb_secret_token_value');
		writeFileSync(file, Buffer.from('tampered tampered tampered tampered tampered'));
		expect(store.get('board.example.com')).toBeNull();
		store.set('board.example.com', 'second');
		store.delete('board.example.com');
		expect(store.get('board.example.com')).toBeNull();
		rmSync(home, { recursive: true, force: true });
	});

	it.runIf(process.platform === 'win32')(
		'on Windows the secret is a DPAPI blob that is not the plain token',
		() => {
			const home = mkdtempSync(join(tmpdir(), 'afb-dpapi-'));
			const store = windowsStore(home);
			store.set('board.example.com', 'afb_dpapi_token_value');
			expect(store.get('board.example.com')).toBe('afb_dpapi_token_value');
			expect(require_file_text(join(home, 'token-board.example.com.dpapi'))).not.toContain(
				'afb_dpapi_token_value'
			);
			store.delete('board.example.com');
			rmSync(home, { recursive: true, force: true });
		}
	);
});

import { readFileSync } from 'node:fs';
function require_file_text(file: string): string {
	return readFileSync(file).toString('latin1');
}
