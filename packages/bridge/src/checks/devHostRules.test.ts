// HOST RULES IN THE WRITE ALLOWLIST, STORAGE SIGN-IN DETECTION AND THE HOSTS HANDED TO THE SEED (AFB-20261114-1120)

// -- DEP-MODULES -- //
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	allowlistHosts,
	cleanWriteAllowlist,
	DEV_STATUS_FIX_LINES,
	devConfigHash,
	writeRuleAllowed
} from './devPolicy.js';
import { guardContext, type RouteLike } from './guard.js';
import { gainedSignin, loginCommand, storageMarks } from './login.js';
import { listProfiles } from './profiles.js';
import { registerProject } from './registry.js';

// -- CONSTANTS -- //

const ORIGIN = 'http://localhost:5173';
const DATA = 'abc.supabase.co';
const RPC = `https://${DATA}/rest/v1/rpc/cl_my_family`;

// -- FUNCTIONS -- //

/** Runs one request through a guard and says whether it was let through. */
async function passes(
	options: Parameters<typeof guardContext>[1],
	url: string,
	method: string
): Promise<{ passed: boolean; counts: { writes: number; outside: number } }> {
	let handler: (route: RouteLike) => void | Promise<void> = () => {};
	const counts = await guardContext({ route: async (_p, h) => void (handler = h) }, options);
	let passed = false;
	await handler({
		request: () => ({ url: () => url, method: () => method, resourceType: () => 'fetch' }),
		continue: async () => void (passed = true),
		abort: async () => {},
		fulfill: async () => {}
	});
	return { passed, counts };
}

describe('write allowlist rules that name a host', () => {
	it('reads "POST https://host/path" into a host rule and keeps own-origin rules as they were', () => {
		expect(cleanWriteAllowlist([`POST ${RPC}`, 'POST /api/drafts'])).toEqual([
			{ method: 'POST', pathPrefix: '/api/drafts' },
			{ method: 'POST', pathPrefix: '/rest/v1/rpc/cl_my_family', host: DATA }
		]);
		expect(allowlistHosts(cleanWriteAllowlist([`POST ${RPC}`]))).toEqual([DATA]);
	});

	it('refuses GET, a wildcard, a query, user info and a whole host', () => {
		expect(() => cleanWriteAllowlist([`GET ${RPC}`])).toThrow(/GET\/HEAD\/OPTIONS/);
		expect(() => cleanWriteAllowlist([`POST https://${DATA}/rest/*`])).toThrow();
		expect(() => cleanWriteAllowlist([`POST ${RPC}?x=1`])).toThrow(/fixed path/);
		expect(() => cleanWriteAllowlist([`POST https://u:p@${DATA}/x`])).toThrow(/fixed path/);
		expect(() => cleanWriteAllowlist([`POST https://${DATA}`])).toThrow(/needs a path/);
		expect(() =>
			cleanWriteAllowlist([{ method: 'POST', pathPrefix: '/x', host: 'a b' }])
		).toThrow();
	});

	it('leaves the hash of an own-origin rule unchanged and binds a host rule into the hash', () => {
		const own = {
			devUrl: ORIGIN,
			allowWrites: true,
			writeAllowlist: [{ method: 'POST' as const, pathPrefix: '/api/drafts' }]
		};
		const withHost = {
			...own,
			writeAllowlist: [
				...own.writeAllowlist,
				{ method: 'POST' as const, pathPrefix: '/rpc/a', host: DATA }
			]
		};
		const otherHost = {
			...own,
			writeAllowlist: [
				...own.writeAllowlist,
				{ method: 'POST' as const, pathPrefix: '/rpc/a', host: 'other.example' }
			]
		};
		expect(devConfigHash(own)).toBe(
			devConfigHash({ ...own, writeAllowlist: [{ method: 'POST', pathPrefix: '/api/drafts' }] })
		);
		// Pinned from the hash the code produced before host rules existed, so a change to the hashed shape of an old rule is caught
		expect(devConfigHash(own)).toBe(
			'428d1af62464f6d06ffe59246bfb74a95d6bc3325a4a3da10a3d5eb59436d53f'
		);
		expect(devConfigHash(withHost)).not.toBe(devConfigHash(own));
		expect(devConfigHash(withHost)).not.toBe(devConfigHash(otherHost));
	});

	it('matches a host rule only for its own host', () => {
		const rules = cleanWriteAllowlist([`POST ${RPC}`]);
		expect(writeRuleAllowed('POST', '/rest/v1/rpc/cl_my_family', rules, DATA)).toBe(true);
		expect(writeRuleAllowed('POST', '/rest/v1/rpc/cl_my_family', rules)).toBe(false);
		expect(writeRuleAllowed('POST', '/rest/v1/rpc/cl_my_family', rules, 'other.example')).toBe(
			false
		);
	});

	it('has fix lines for the two new situations', () => {
		expect(DEV_STATUS_FIX_LINES.DEV_ALLOWLIST_HOST_NOT_REGISTERED).toMatch(/--extra-hosts/);
		expect(DEV_STATUS_FIX_LINES.DEV_WRITE_STOPPED).toMatch(/--write-allowlist/);
	});
});

describe('the write guard and host rules', () => {
	const rules = cleanWriteAllowlist([`POST ${RPC}`, 'POST /api/drafts']);
	const base = { origin: ORIGIN, allowWrites: true, writeAllowlist: rules, extraHosts: [DATA] };

	it('lets the named read-only RPC POST through to the extra host', async () => {
		const r = await passes(base, RPC, 'POST');
		expect(r.passed).toBe(true);
		expect(r.counts).toEqual({ writes: 0, outside: 0 });
	});

	it('stops every other write to that host and counts it', async () => {
		for (const [url, method] of [
			[`https://${DATA}/rest/v1/rpc/cl_delete_all`, 'POST'],
			[`https://${DATA}/rest/v1/profiles`, 'POST'],
			[RPC, 'DELETE']
		] as const) {
			const r = await passes(base, url, method);
			expect(r.passed).toBe(false);
			expect(r.counts.writes).toBe(1);
		}
	});

	it('does not open the host through a rule without one, nor the app through a host rule', async () => {
		const own = await passes(base, `https://${DATA}/api/drafts/1`, 'POST');
		expect(own.passed).toBe(false);
		const app = await passes(base, `${ORIGIN}/rest/v1/rpc/cl_my_family`, 'POST');
		expect(app.passed).toBe(false);
		const ok = await passes(base, `${ORIGIN}/api/drafts/1`, 'POST');
		expect(ok.passed).toBe(true);
	});

	it('needs the host in extraHosts and allowWrites on', async () => {
		const noHost = await passes({ ...base, extraHosts: [] }, RPC, 'POST');
		expect(noHost.passed).toBe(false);
		expect(noHost.counts.outside).toBe(1);
		const off = await passes({ ...base, allowWrites: false }, RPC, 'POST');
		expect(off.passed).toBe(false);
	});

	it('still lets reads of the extra host through', async () => {
		const r = await passes(
			{ origin: ORIGIN, extraHosts: [DATA] },
			`https://${DATA}/auth/v1/user`,
			'GET'
		);
		expect(r.passed).toBe(true);
	});
});

describe('registering a host rule', () => {
	let tmp = '';
	let savedHome: string | undefined;

	beforeEach(() => {
		tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-hostrule-')));
		savedHome = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(tmp, 'bridge-home');
		mkdirSync(process.env.AFB_BRIDGE_HOME, { recursive: true });
	});

	afterEach(() => {
		if (savedHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = savedHome;
		rmSync(tmp, { recursive: true, force: true });
	});

	it('refuses a host rule whose host is not in --extra-hosts', () => {
		expect(() =>
			registerProject({
				org: 'acme',
				name: 'DOKWD',
				devUrl: ORIGIN,
				allowWrites: true,
				writeAllowlist: [`POST ${RPC}`]
			})
		).toThrow(/not in --extra-hosts/);
	});

	it('does not refuse it for the extra-hosts reason once the host is listed', () => {
		let message = '';
		try {
			registerProject({
				org: 'acme',
				name: 'DOKWD',
				devUrl: ORIGIN,
				allowWrites: true,
				extraHosts: [DATA],
				writeAllowlist: [`POST ${RPC}`]
			});
		} catch (e) {
			message = e instanceof Error ? e.message : String(e);
		}
		// It may still ask for the owner's dev approval, which is the intended next step
		expect(message).not.toMatch(/not in --extra-hosts/);
	});
});

describe('a sign-in that lives in the browser', () => {
	const before = (state: unknown, cookies: string[] = []) => ({
		cookies: new Set(cookies),
		marks: storageMarks(state)
	});
	const site = (items: { name: string; value: string }[], idb: string[] = []) => ({
		cookies: [],
		origins: [
			{
				origin: ORIGIN,
				localStorage: items,
				indexedDB: idb.map((name) => ({ name }))
			}
		]
	});

	it('sees a new localStorage key with no cookie', () => {
		const loaded = site([{ name: 'theme', value: 'dark' }]);
		const signedIn = site([
			{ name: 'theme', value: 'dark' },
			{ name: 'sb-abc-auth-token', value: '{"x":1}' }
		]);
		expect(gainedSignin(before(loaded), signedIn)).toBe(true);
	});

	it('sees a changed session key but ignores keys that were there and did not change', () => {
		const loaded = site([
			{ name: 'sb-abc-auth-token', value: 'old' },
			{ name: 'theme', value: 'dark' }
		]);
		expect(gainedSignin(before(loaded), loaded)).toBe(false);
		expect(
			gainedSignin(
				before(loaded),
				site([
					{ name: 'sb-abc-auth-token', value: 'new' },
					{ name: 'theme', value: 'dark' }
				])
			)
		).toBe(true);
		expect(
			gainedSignin(
				before(loaded),
				site([
					{ name: 'sb-abc-auth-token', value: 'old' },
					{ name: 'theme', value: 'light' }
				])
			)
		).toBe(false);
	});

	it('sees a new IndexedDB database and still sees a new cookie', () => {
		const loaded = site([]);
		expect(gainedSignin(before(loaded), site([], ['firebaseLocalStorageDb']))).toBe(true);
		expect(
			gainedSignin(before(loaded), { cookies: [{ name: 'sid', domain: 'localhost' }], origins: [] })
		).toBe(true);
	});

	it('ignores keys and databases an app writes by itself after load', () => {
		const loaded = site([{ name: 'theme', value: 'dark' }]);
		const later = site(
			[
				{ name: 'theme', value: 'dark' },
				{ name: 'locale', value: 'en' },
				{ name: 'analytics_id', value: 'a1' },
				{ name: 'last_user_email', value: 'x@y.z' }
			],
			['workbox-expiration']
		);
		expect(gainedSignin(before(loaded), later)).toBe(false);
	});

	it('times out as before when nothing changes', () => {
		const loaded = site([{ name: 'theme', value: 'dark' }]);
		expect(gainedSignin(before(loaded), loaded)).toBe(false);
	});
});

describe('check login with a browser-only session', () => {
	let tmp = '';
	let savedHome: string | undefined;

	beforeEach(() => {
		tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-loginstore-')));
		savedHome = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(tmp, 'bridge-home');
		mkdirSync(process.env.AFB_BRIDGE_HOME, { recursive: true });
		registerProject({ org: 'acme', name: 'DOKWD', devUrl: ORIGIN, extraHosts: [DATA] });
	});

	afterEach(() => {
		if (savedHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = savedHome;
		rmSync(tmp, { recursive: true, force: true });
	});

	const target = async () => ({ baseUrl: ORIGIN, hosts: [DATA], stop: async () => undefined });

	it('saves a state that has a localStorage origin and no cookie', async () => {
		const logs: string[] = [];
		const code = await loginCommand(['DOKWD', '--seeded', ORIGIN + '/#x', '--org', 'acme'], {
			json: false,
			log: (l) => logs.push(l),
			out: () => {},
			deps: {
				target,
				seedFromUrl: async () => ({
					cookies: [],
					origins: [
						{ origin: ORIGIN, localStorage: [{ name: 'sb-abc-auth-token', value: 'secret-token' }] }
					]
				})
			}
		});
		expect(code).toBe(0);
		expect(listProfiles('acme', 'DOKWD')).toHaveLength(1);
		expect(logs.join('\n')).not.toContain('secret-token');
	});

	it('hands the registration extra hosts to the seed browser', async () => {
		let seen: string[] | undefined;
		const code = await loginCommand(['DOKWD', '--seeded', ORIGIN + '/#x', '--org', 'acme'], {
			json: false,
			log: () => {},
			out: () => {},
			deps: {
				target,
				seedFromUrl: async (_b, _s, _p, hosts) => {
					seen = hosts;
					return {
						cookies: [],
						origins: [{ origin: ORIGIN, localStorage: [{ name: 'k', value: 'v' }] }]
					};
				}
			}
		});
		expect(code).toBe(0);
		expect(seen).toEqual([DATA]);
	});

	it('the seed browser guard reaches the data host for reads and stops its writes', async () => {
		const read = await passes(
			{ origin: ORIGIN, extraHosts: [DATA] },
			`https://${DATA}/auth/v1/user`,
			'GET'
		);
		expect(read.passed).toBe(true);
		const write = await passes({ origin: ORIGIN, extraHosts: [DATA] }, RPC, 'POST');
		expect(write.passed).toBe(false);
		const other = await passes(
			{ origin: ORIGIN, extraHosts: [DATA] },
			'https://evil.example/x',
			'GET'
		);
		expect(other.passed).toBe(false);
	});
});
