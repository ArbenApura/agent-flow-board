/* eslint-disable @typescript-eslint/no-explicit-any -- tool replies are parsed from JSON and read loosely in tests */
// 6.9: THE STDIO BRIDGE END TO END AGAINST THE REAL /mcp HANDLER, WITH THE OFFLINE QUEUE, THE DEVICE SIGN IN AND THE TOKEN STORE

// -- DEP-MODULES -- //
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
import { isNetworkError, runBridge } from './bridge';
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

	it('starts one background sign in when the saved token is refused, answers at once, then carries on', async () => {
		let logins = 0;
		const b = start({ fetch: shim(), token: 'afb_expired', login: async () => (logins++, token) });
		// The refused call is answered with a clear tool error and does not wait for the sign in
		const refused = await b.rpc('tools/call', { name: 'session_start', arguments: { tool: 'x' } });
		expect(refused.result.isError).toBe(true);
		expect(refused.result.content[0].text).toContain('sign in');
		for (let i = 0; i < 100 && logins < 1; i++) await new Promise((r) => setTimeout(r, 10));
		expect(logins).toBe(1);
		expect(b.logs.some((l) => l.includes('no longer valid'))).toBe(true);
		await init(b);
		expect(logins).toBe(1);
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

// -- HANG GUARDS -- //

describe('bridge hang guards', () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	/** A bridge on a pair of streams against a mock fetch, with no board behind it. */
	function mini(fetchImpl: Fetch, extra: { postTimeoutMs?: number } = {}) {
		const dir = mkdtempSync(join(tmpdir(), 'afb-guard-'));
		dirs.push(dir);
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const lines: any[] = [];
		let buf = '';
		stdout.on('data', (c) => {
			buf += c.toString();
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				lines.push(JSON.parse(buf.slice(0, i)));
				buf = buf.slice(i + 1);
			}
		});
		const queue = new Queue(join(dir, 'queue.json'));
		const logs: string[] = [];
		const done = runBridge({
			server: BASE,
			fetch: fetchImpl,
			getToken: () => 'afb_test',
			login: async () => 'afb_new',
			queue,
			stdin,
			stdout,
			log: (l) => logs.push(l),
			replayEveryMs: 0,
			...extra
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
		return {
			rpc,
			queue,
			dir,
			logs,
			end: async () => {
				stdin.end();
				await done;
			}
		};
	}

	it('only a failure to reach the board counts as a network error, not any TypeError', () => {
		expect(isNetworkError(new TypeError('fetch failed'))).toBe(true);
		expect(isNetworkError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
		expect(
			isNetworkError(Object.assign(new TypeError('x'), { cause: { code: 'ENOTFOUND' } }))
		).toBe(true);
		expect(isNetworkError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(
			false
		);
		expect(isNetworkError(new Error('network says no'))).toBe(false);
		expect(isNetworkError(null)).toBe(false);
	});

	it('a request that hangs is given up on, answered with a clear error and never queued', async () => {
		// A fetch that never answers but honours the signal, as the real one does
		const hang: Fetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
			});
		const b = mini(hang, { postTimeoutMs: 60 });
		const reply = await b.rpc('tools/call', { name: 'task_new', arguments: { title: 'x' } });
		expect(reply.error.message).toContain('did not answer');
		expect(reply.error.message).toContain('may or may not');
		expect(b.queue.list()).toHaveLength(0);
		await b.end();
	});

	it('a bug in the bridge is shown, not hidden as offline', async () => {
		const broken: Fetch = async () => {
			throw new TypeError("Cannot read properties of undefined (reading 'x')");
		};
		const b = mini(broken);
		const reply = await b.rpc('tools/list');
		expect(reply.error.message).toContain('Cannot read properties');
		await b.end();
	});

	it('a 401 answers at once with a sign in message and starts the sign in only once', async () => {
		let logins = 0;
		let release: (t: string) => void = () => undefined;
		const dir = mkdtempSync(join(tmpdir(), 'afb-guard-'));
		dirs.push(dir);
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const lines: any[] = [];
		stdout.on('data', (c) => {
			for (const l of c.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l));
		});
		const done = runBridge({
			server: BASE,
			fetch: async () => new Response('{}', { status: 401 }),
			getToken: () => 'afb_old',
			login: () =>
				new Promise<string>((resolve) => {
					logins++;
					release = resolve;
				}),
			queue: new Queue(join(dir, 'queue.json')),
			stdin,
			stdout,
			log: () => undefined,
			replayEveryMs: 0
		});
		for (const id of [1, 2, 3])
			stdin.write(
				JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'x' } }) + '\n'
			);
		for (let i = 0; i < 300 && lines.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
		expect(lines).toHaveLength(3);
		expect(
			lines.every((l) => l.result.isError && l.result.content[0].text.includes('sign in'))
		).toBe(true);
		expect(logins).toBe(1);
		release('afb_new');
		stdin.end();
		await done;
	});
});

describe('the offline queue lock', () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});
	const fresh = () => {
		const d = mkdtempSync(join(tmpdir(), 'afb-qlock-'));
		dirs.push(d);
		return join(d, 'queue.json');
	};

	it('takes over a stale lock left by a dead process, and removes its own lock afterwards', () => {
		const file = fresh();
		writeFileSync(`${file}.lock`, '99999');
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${file}.lock`, old, old);
		const q = new Queue(file);
		const e = q.enqueue('task_new', { title: 'a' });
		expect(q.list().map((x) => x.id)).toEqual([e.id]);
		expect(existsSync(`${file}.lock`)).toBe(false);
	});

	it('waits for a fresh lock and takes it over when the wait ends', () => {
		const file = fresh();
		writeFileSync(`${file}.lock`, '99999');
		const q = new Queue(file, { staleMs: 60_000, waitMs: 120 });
		const started = Date.now();
		q.enqueue('task_new', { title: 'a' });
		expect(Date.now() - started).toBeGreaterThanOrEqual(100);
		expect(q.list()).toHaveLength(1);
		expect(existsSync(`${file}.lock`)).toBe(false);
	});

	it('keeps a write that is queued while a replay is sending', async () => {
		const file = fresh();
		const q = new Queue(file);
		q.enqueue('task_new', { title: 'first', item: 'A' });
		const r = await q.replay(async () => {
			// A second bridge queues a write while this one is in the middle of sending
			new Queue(file).enqueue('task_new', { title: 'second', item: 'B' });
			return { kind: 'ok' };
		});
		expect(r.sent).toBe(1);
		expect(q.list().map((x) => x.args.title)).toEqual(['second']);
	});
});
