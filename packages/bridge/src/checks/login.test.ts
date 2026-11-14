// TESTS OF `check login`, THE SEEDED ACCOUNT, WHEN A SAVED SIGN-IN IS USED, AND WHEN PICTURES MAY BE UPLOADED.

// IMPORTED DEP-MODULES
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// -- MOCKS -- //

// The sealed store is another module's job: a plain stand-in is enough here (nothing is written to disk by these tests)
vi.mock('./store.js', () => ({
	seal: (_aad: string, data: Uint8Array) => data,
	unseal: (_aad: string, blob: Uint8Array) => blob
}));

// IMPORTED MODULES
import {
	chooseState,
	desktopProblem,
	envNames,
	keepRelated,
	loginCommand,
	pictureUploadAllowed,
	savedStateFor,
	seededAccount
} from './login.js';
import { saveProfile } from './profiles.js';
import { stateDirFor } from './paths.js';
import type { HeadedOutcome, LoginCtx, LoginTarget } from './login.js';
import type { Registration } from './types.js';

// -- CONSTANTS -- //

const REG: Registration = {
	org: 'acme',
	name: 'HAPR-D',
	boardProject: 'HAPR',
	url: 'https://demo.example.com',
	recipe: false,
	database: 'none',
	adoptEnv: false,
	uploadSignedInPictures: false,
	createdAt: '2026-11-08T00:00:00.000Z'
};
const STATE = {
	cookies: [{ name: 's', value: 'cookie-secret-value', domain: 'demo.example.com' }],
	origins: []
};

// -- FUNCTIONS -- //

function setup(over: Partial<NonNullable<LoginCtx['deps']>> = {}) {
	const lines: string[] = [];
	const outs: string[] = [];
	const saved: unknown[][] = [];
	let stopped = 0;
	const target: LoginTarget = {
		baseUrl: 'https://demo.example.com',
		stop: async () => void stopped++
	};
	const ctx: LoginCtx = {
		log: (l) => void lines.push(l),
		out: (l) => void outs.push(l),
		json: false,
		deps: {
			desktop: () => null,
			approval: { peek: (_t, c) => c === 'GOOD', consume: (_t, c) => c === 'GOOD' },
			env: {},
			loadRegistration: (org, name) => (org === 'acme' && name === 'HAPR-D' ? REG : null),
			target: async () => target,
			save: (...a) => void saved.push(a),
			audit: () => undefined,
			ask: async () => '',
			signIn: vi.fn(async () => STATE),
			headed: vi.fn(async (): Promise<HeadedOutcome> => ({ state: 'signed-in', storage: STATE })),
			...over
		}
	};
	return { ctx, lines, outs, saved, stopped: () => stopped };
}

describe('seededAccount', () => {
	it('names the variables from the upper cased name with dashes as underscores', () => {
		expect(envNames('HAPR-d')).toEqual({
			email: 'AFB_CHECKS_HAPR_D_EMAIL',
			password: 'AFB_CHECKS_HAPR_D_PASSWORD'
		});
	});
	it('reads both variables, or returns null when either is missing or empty', () => {
		const env = { AFB_CHECKS_HAPR_D_EMAIL: 'a@b.co', AFB_CHECKS_HAPR_D_PASSWORD: 'pw-123456' };
		expect(seededAccount('hapr-d', env)).toEqual({ email: 'a@b.co', password: 'pw-123456' });
		expect(seededAccount('hapr-d', { AFB_CHECKS_HAPR_D_EMAIL: 'a@b.co' })).toBeNull();
		expect(seededAccount('hapr-d', { ...env, AFB_CHECKS_HAPR_D_PASSWORD: '' })).toBeNull();
	});
});

describe('loginCommand --seeded', () => {
	it('signs in with the seeded account, saves for the site, prints no cookie or password', async () => {
		const t = setup({
			env: { AFB_CHECKS_HAPR_D_EMAIL: 'me@x.co', AFB_CHECKS_HAPR_D_PASSWORD: 'super-secret-pw' }
		});
		t.ctx.json = true;
		expect(await loginCommand(['HAPR-D', '--org', 'acme', '--seeded'], t.ctx)).toBe(0);
		expect(t.ctx.deps?.signIn).toHaveBeenCalledWith('https://demo.example.com', {
			email: 'me@x.co',
			password: 'super-secret-pw'
		});
		expect(t.saved).toEqual([
			[
				'acme',
				'HAPR-D',
				'https://demo.example.com',
				STATE,
				{ profile: 'default', sealedHost: null }
			]
		]);
		const printed = [...t.lines, ...t.outs].join('\n');
		expect(printed).not.toContain('super-secret-pw');
		expect(printed).not.toContain('cookie-secret-value');
		expect(t.stopped()).toBe(1);
	});
	it('falls back to the recipe test user of the target', async () => {
		const t = setup();
		const target: LoginTarget = {
			baseUrl: 'http://127.0.0.1:6001',
			testUser: { email: 't@x.co', password: 'test-user-pw' },
			stop: async () => undefined
		};
		t.ctx.deps = { ...t.ctx.deps, target: async () => target };
		expect(await loginCommand(['HAPR-D', '--org', 'acme', '--seeded'], t.ctx)).toBe(0);
		expect(t.ctx.deps.signIn).toHaveBeenCalledWith('http://127.0.0.1:6001', {
			email: 't@x.co',
			password: 'test-user-pw'
		});
		expect(t.saved[0][2]).toBe('http://127.0.0.1:6001');
	});
	it('says which variables to set when there is no account', async () => {
		const t = setup();
		expect(await loginCommand(['HAPR-D', '--org', 'acme', '--seeded'], t.ctx)).toBe(1);
		expect(t.lines.join(' ')).toContain('AFB_CHECKS_HAPR_D_EMAIL');
		expect(t.saved).toEqual([]);
	});
	it('never shows the password when the sign in fails', async () => {
		const t = setup({
			env: { AFB_CHECKS_HAPR_D_EMAIL: 'me@x.co', AFB_CHECKS_HAPR_D_PASSWORD: 'super-secret-pw' },
			signIn: async () => {
				throw new Error('failed with super-secret-pw in it');
			}
		});
		expect(await loginCommand(['HAPR-D', '--org', 'acme', '--seeded'], t.ctx)).toBe(2);
		expect(t.lines.join(' ')).not.toContain('super-secret-pw');
		expect(t.stopped()).toBe(1);
	});
	it('refuses an unknown registration, a missing org and a bad name', async () => {
		const t = setup();
		expect(await loginCommand(['NOPE', '--org', 'acme', '--seeded'], t.ctx)).toBe(1);
		expect(await loginCommand(['HAPR-D', '--seeded'], t.ctx)).toBe(1);
		expect(await loginCommand(['../x', '--org', 'acme', '--seeded'], t.ctx)).toBe(1);
	});
	it('saves nothing when the state holds no sign-in', async () => {
		const t = setup({
			env: { AFB_CHECKS_HAPR_D_EMAIL: 'me@x.co', AFB_CHECKS_HAPR_D_PASSWORD: 'super-secret-pw' },
			signIn: async () => ({ cookies: [], origins: [] })
		});
		expect(await loginCommand(['HAPR-D', '--org', 'acme', '--seeded'], t.ctx)).toBe(1);
		expect(t.saved).toEqual([]);
	});
});

describe('loginCommand headed', () => {
	it('is refused with one plain sentence when there is no desktop to show a window on, and opens nothing', async () => {
		const t = setup({ desktop: () => 'This process has no desktop to show a window on.' });
		expect(await loginCommand(['HAPR-D', '--org', 'acme', '--approval', 'GOOD'], t.ctx)).toBe(1);
		expect(t.lines).toEqual(['This process has no desktop to show a window on.']);
		expect(t.ctx.deps?.headed).not.toHaveBeenCalled();
	});
	it('is refused without the owner approval, with the way to ask for it, and opens nothing', async () => {
		const t = setup();
		expect(await loginCommand(['HAPR-D', '--org', 'acme'], t.ctx)).toBe(1);
		expect(await loginCommand(['HAPR-D', '--org', 'acme', '--approval', 'WRONG'], t.ctx)).toBe(1);
		expect(t.lines[0]).toMatch(/check approve --request --action login --target acme\/HAPR-D/);
		expect(t.ctx.deps?.headed).not.toHaveBeenCalled();
	});
	it('uses the approval up before the window opens, then saves the state', async () => {
		const consume = vi.fn(() => true);
		const t = setup({ approval: { peek: () => true, consume } });
		expect(await loginCommand(['HAPR-D', '--org', 'acme', '--approval', 'GOOD'], t.ctx)).toBe(0);
		expect(consume.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(t.ctx.deps!.headed!).mock.invocationCallOrder[0]!
		);
		expect(t.ctx.deps?.signIn).not.toHaveBeenCalled();
		expect(t.saved).toHaveLength(1);
		expect(t.stopped()).toBe(1);
	});
	it('does not open a window when the code was used between the look and the use', async () => {
		const t = setup({ approval: { peek: () => true, consume: () => false } });
		expect(await loginCommand(['HAPR-D', '--org', 'acme', '--approval', 'GOOD'], t.ctx)).toBe(1);
		expect(t.ctx.deps?.headed).not.toHaveBeenCalled();
	});
	it('ends with its own exit code when the window is closed (4) or the time runs out (5), and saves nothing', async () => {
		const closed = setup({
			headed: vi.fn(async (): Promise<HeadedOutcome> => ({ state: 'closed' }))
		});
		expect(await loginCommand(['HAPR-D', '--org', 'acme', '--approval', 'GOOD'], closed.ctx)).toBe(
			4
		);
		const late = setup({
			headed: vi.fn(async (): Promise<HeadedOutcome> => ({ state: 'timeout' }))
		});
		expect(
			await loginCommand(
				['HAPR-D', '--org', 'acme', '--approval', 'GOOD', '--timeout', '1'],
				late.ctx
			)
		).toBe(5);
		expect(closed.saved).toEqual([]);
		expect(late.saved).toEqual([]);
		expect(
			await loginCommand(
				['HAPR-D', '--org', 'acme', '--approval', 'GOOD', '--timeout', '99'],
				setup().ctx
			)
		).toBe(1);
	});
	it('says a desktop exists only where one can show a window', () => {
		expect(desktopProblem({ SESSIONNAME: 'Console' }, 'win32')).toBeNull();
		expect(desktopProblem({}, 'win32')).toMatch(/no desktop/);
		expect(desktopProblem({ DISPLAY: ':0' }, 'linux')).toBeNull();
		expect(desktopProblem({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBeNull();
		expect(desktopProblem({}, 'linux')).toMatch(/no desktop/);
		expect(desktopProblem({ SSH_CONNECTION: 'x' }, 'darwin')).toMatch(/no desktop/);
		expect(desktopProblem({}, 'darwin')).toBeNull();
	});
});

describe('keepRelated', () => {
	it('keeps only cookies and origins of the site hosts', () => {
		const kept = keepRelated(
			{
				cookies: [
					{ domain: 'demo.example.com' },
					{ domain: '.example.com' },
					{ domain: 'evil.test' }
				],
				origins: [{ origin: 'https://demo.example.com' }, { origin: 'https://evil.test' }]
			},
			['demo.example.com']
		);
		expect(kept.cookies).toHaveLength(2);
		expect(kept.origins).toHaveLength(1);
	});
});

describe('chooseState', () => {
	const profile = { bindKey: 'https://demo.example.com', savedAt: '', state: STATE };
	it('uses the saved sign-in only when the script or check names that registration', () => {
		expect(chooseState({ registration: 'HAPR-D', scriptRegistration: 'HAPR-D', profile })).toBe(
			'saved'
		);
		expect(chooseState({ registration: 'hapr-d', scriptRegistration: 'HAPR-D', profile })).toBe(
			'saved'
		);
	});
	it('does not use it when the registration was reached another way or names another', () => {
		expect(chooseState({ registration: 'HAPR-D', scriptRegistration: null, profile })).toBe('none');
		expect(chooseState({ registration: 'HAPR-D', scriptRegistration: undefined, profile })).toBe(
			'none'
		);
		expect(chooseState({ registration: 'HAPR-D', scriptRegistration: 'HAPR-M', profile })).toBe(
			'none'
		);
	});
	it('is none without a saved sign-in', () => {
		expect(chooseState({ registration: 'A', scriptRegistration: 'A', profile: null })).toBe('none');
	});
});

describe('pictureUploadAllowed', () => {
	it('uploads a signed-out run always', () => {
		expect(pictureUploadAllowed({ uploadSignedInPictures: false }, false)).toBe(true);
	});
	it('uploads a signed-in run only with the owner opt in', () => {
		expect(pictureUploadAllowed({ uploadSignedInPictures: false }, true)).toBe(false);
		expect(pictureUploadAllowed({ uploadSignedInPictures: true }, true)).toBe(true);
	});
});

describe('savedStateFor (C19)', () => {
	let home = '';
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-login-saved-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});
	const input = {
		org: 'acme',
		registration: 'HAPR-D',
		scriptRegistration: 'HAPR-D',
		bindKey: 'https://demo.example.com'
	};

	it('hands over the saved sign-in of the registration the script names', () => {
		saveProfile('acme', 'HAPR-D', input.bindKey, STATE);
		const got = savedStateFor(input);
		expect(got?.profile?.state).toEqual(STATE);
	});

	it('says the sign-in is damaged instead of silently running signed out', () => {
		const file = saveProfile('acme', 'HAPR-D', input.bindKey, STATE);
		writeFileSync(join(stateDirFor('acme', 'HAPR-D'), 'profiles', file), 'junk');
		const got = savedStateFor(input);
		expect(got?.profile).toBeNull();
		expect(got?.note).toMatch(/saved sign-in is damaged, make it again/);
	});

	it('is quiet when there is no saved sign-in at all', () => {
		expect(savedStateFor(input)).toBeNull();
	});
});
