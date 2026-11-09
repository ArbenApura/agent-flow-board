// `check login` FOR A REPO REGISTRATION: THE PREVIEW IS ITS SITE, THE SIGN-IN IS BOUND TO THE LOOPBACK AND THE SEALED PROJECT, AND EVERY REFUSAL HAPPENS BEFORE A WINDOW OPENS

// -- DEP-MODULES -- //
import { describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import { allowedHosts, linkProblem, loginCommand } from './login.js';
import type { HeadedOutcome, LoginCtx, LoginTarget } from './login.js';
import type { Registration } from './types.js';

// -- CONSTANTS -- //

const REPO_REG: Registration = {
	org: 'acme',
	name: 'HAPRM',
	boardProject: 'HAPR',
	repo: 'C:/repo',
	recipe: true,
	database: 'none',
	adoptEnv: false,
	uploadSignedInPictures: false,
	createdAt: '2026-11-09T00:00:00.000Z'
};
const STATE = {
	cookies: [{ name: 'sb', value: 'cookie-value', domain: '127.0.0.1' }],
	origins: []
};

// -- FUNCTIONS -- //

function setup(
	target: Partial<LoginTarget> = {},
	over: Partial<NonNullable<LoginCtx['deps']>> = {}
) {
	const lines: string[] = [];
	const saved: unknown[][] = [];
	const audits: unknown[][] = [];
	let stopped = 0;
	const full: LoginTarget = {
		baseUrl: 'http://127.0.0.1:5301',
		hosts: ['proj.supabase.co'],
		restrictHosts: true,
		sealedHost: 'proj.supabase.co',
		throwawayDatabase: false,
		mail: null,
		stop: async () => void stopped++,
		...target
	};
	const headed = vi.fn(async (): Promise<HeadedOutcome> => ({
		state: 'signed-in',
		storage: STATE
	}));
	const consume = vi.fn((_t: string, c: string) => c === 'GOOD');
	const ctx: LoginCtx = {
		log: (l) => void lines.push(l),
		out: () => undefined,
		json: false,
		deps: {
			desktop: () => null,
			approval: { peek: (_t, c) => c === 'GOOD', consume },
			env: {},
			loadRegistration: (org, name) => (org === 'acme' && name === 'HAPRM' ? REPO_REG : null),
			target: async () => full,
			save: (...a) => void saved.push(a),
			audit: (...a) => void audits.push(a),
			ask: async () => '',
			signIn: vi.fn(async () => STATE),
			headed,
			...over
		}
	};
	return { ctx, lines, saved, audits, headed, consume, stopped: () => stopped };
}

describe('check login on a repo registration', () => {
	it('signs in on the preview and binds the sign-in to the loopback and the sealed project, not to the port', async () => {
		const t = setup();
		expect(await loginCommand(['HAPRM', '--org', 'acme', '--approval', 'GOOD'], t.ctx)).toBe(0);
		expect(t.saved).toEqual([
			['acme', 'HAPRM', '127.0.0.1', STATE, { profile: 'default', sealedHost: 'proj.supabase.co' }]
		]);
		expect(t.audits).toEqual([['login saved', { registration: 'acme/HAPRM', profile: 'default' }]]);
		expect(t.stopped()).toBe(1);
		expect(t.lines.join('\n')).not.toContain('cookie-value');
		expect(t.lines.join('\n')).not.toContain(':5301');
	});

	it('--as saves a named profile beside the default', async () => {
		const t = setup();
		expect(
			await loginCommand(
				['HAPRM', '--org', 'acme', '--as', 'read-only', '--approval', 'GOOD'],
				t.ctx
			)
		).toBe(0);
		expect(t.saved[0]?.[2]).toBe('127.0.0.1#read-only');
		expect(t.saved[0]?.[4]).toEqual({ profile: 'read-only', sealedHost: 'proj.supabase.co' });
		expect(t.lines.join('\n')).toMatch(/Saved the sign-in "read-only"/);
	});

	it('refuses a profile name that could reach a path', async () => {
		const t = setup();
		expect(
			await loginCommand(['HAPRM', '--org', 'acme', '--as', '../x', '--approval', 'GOOD'], t.ctx)
		).toBe(1);
		expect(t.headed).not.toHaveBeenCalled();
		expect(t.saved).toEqual([]);
	});

	it('refuses a preview on a throwaway database before any window opens, and stops the preview', async () => {
		const t = setup({ throwawayDatabase: true, sealedHost: null });
		expect(await loginCommand(['HAPRM', '--org', 'acme', '--approval', 'GOOD'], t.ctx)).toBe(1);
		expect(t.headed).not.toHaveBeenCalled();
		expect(t.consume).not.toHaveBeenCalled();
		expect(t.saved).toEqual([]);
		expect(t.stopped()).toBe(1);
		expect(t.lines.join('\n')).toMatch(/throwaway database/);
	});

	it('needs the owner approval and a desktop for a window, as for a live site', async () => {
		const t = setup();
		expect(await loginCommand(['HAPRM', '--org', 'acme'], t.ctx)).toBe(1);
		expect(t.lines.join('\n')).toMatch(/needs the owner's approval/);
		const u = setup({}, { desktop: () => 'no desktop' });
		expect(await loginCommand(['HAPRM', '--org', 'acme', '--approval', 'GOOD'], u.ctx)).toBe(1);
		expect(u.headed).not.toHaveBeenCalled();
	});

	it('--seeded is refused on a repo registration without its sealed test project, so no password reaches another database', async () => {
		const t = setup(
			{ sealedHost: null },
			{ env: { AFB_CHECKS_HAPRM_EMAIL: 'a@b.co', AFB_CHECKS_HAPRM_PASSWORD: 'pw-12345678' } }
		);
		expect(await loginCommand(['HAPRM', '--org', 'acme', '--seeded'], t.ctx)).toBe(1);
		expect(t.ctx.deps?.signIn).not.toHaveBeenCalled();
		const ok = setup(
			{},
			{ env: { AFB_CHECKS_HAPRM_EMAIL: 'a@b.co', AFB_CHECKS_HAPRM_PASSWORD: 'pw-12345678' } }
		);
		expect(await loginCommand(['HAPRM', '--org', 'acme', '--seeded'], ok.ctx)).toBe(0);
		expect(ok.saved[0]?.[2]).toBe('127.0.0.1');
		expect(ok.lines.join('\n')).not.toContain('pw-12345678');
	});

	it('a sign-in typed on the board is refused on a repo registration without its sealed test project, as --seeded is', async () => {
		const t = setup({ sealedHost: null });
		t.ctx.board = (() => {
			throw new Error('The board must not be asked.');
		}) as never;
		expect(await loginCommand(['HAPRM', '--org', 'acme', '--from-board'], t.ctx)).toBe(1);
		expect(t.saved).toEqual([]);
		expect(t.lines.join('\n')).toMatch(/needs the registration's sealed test project/);
	});

	it('hands the terminal prompt to the window, so a mail login can read the pasted link', async () => {
		const ask = vi.fn(async () => '');
		const t = setup({ mail: { inbox: 'tests@example.com' } }, { ask });
		await loginCommand(['HAPRM', '--org', 'acme', '--approval', 'GOOD'], t.ctx);
		expect(t.headed.mock.calls[0]?.[3]).toBe(ask);
	});
});

describe('the pasted sign-in link', () => {
	const allowed = allowedHosts({ baseUrl: 'http://127.0.0.1:5301', hosts: ['Proj.Supabase.co'] });
	it('is opened only on the preview or its sealed test project', () => {
		expect(allowed).toEqual(['127.0.0.1:5301', 'proj.supabase.co']);
		expect(linkProblem('http://127.0.0.1:5301/auth/callback?code=x', allowed)).toBeNull();
		expect(linkProblem('https://proj.supabase.co/auth/v1/verify?token=x', allowed)).toBeNull();
	});
	it('is refused for another host, a non web scheme, or text that is not an address', () => {
		expect(linkProblem('https://evil.example/steal', allowed)).toMatch(/not this preview/);
		expect(linkProblem('https://proj.supabase.co.evil.example/x', allowed)).toMatch(
			/not this preview/
		);
		// Another service on this machine (the dev server, the preview on another port) is not this preview
		expect(linkProblem('http://127.0.0.1:5180/x', allowed)).toMatch(/not this preview/);
		expect(linkProblem('http://127.0.0.1/x', allowed)).toMatch(/not this preview/);
		expect(linkProblem('file:///C:/secrets.txt', allowed)).toMatch(/Only a web address/);
		expect(linkProblem('javascript:alert(1)', allowed)).toMatch(/Only a web address/);
		expect(linkProblem('not a link', allowed)).toMatch(/not a web address/);
	});
});
