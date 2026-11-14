// WHICH SAVED SIGN-IN A RUN OPENS WITH: PORT-FREE BINDING, NAMED PROFILES THAT NEVER FALL BACK, AND NO CROSS-USE BETWEEN REGISTRATIONS

// IMPORTED DEP-MODULES
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	assertProfileName,
	bindBaseFor,
	LOOPBACK_BIND,
	listProfiles,
	profileKey,
	removeProfilesNamed,
	retargetOrigins,
	saveProfile
} from './profiles.js';
import { chooseSignin, sealedKey } from './signinChoice.js';
import { profileHeader } from './routing.js';

// -- CONSTANTS -- //

const REPO = { name: 'HAPRM', repo: 'C:/repo' };
const OTHER = { name: 'HAPRN', repo: 'C:/repo' };
const COOKIE_STATE = { cookies: [{ name: 'sb', value: 'v', domain: '127.0.0.1' }], origins: [] };
const LOCAL_STATE = {
	cookies: [],
	origins: [{ origin: 'http://127.0.0.1:5301', localStorage: [{ name: 'sb', value: 'v' }] }]
};
const HOST = 'proj.supabase.co';

// -- FUNCTIONS -- //

describe('a repo registration sign-in', () => {
	let home = '';
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-choice-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});

	const save = (name: string, state: unknown, profile?: string, sealed: string | null = HOST) =>
		saveProfile('acme', name, profileKey(LOOPBACK_BIND, profile), state, {
			profile,
			sealedHost: sealed
		});
	const choose = (over: Partial<Parameters<typeof chooseSignin>[0]> = {}) =>
		chooseSignin({
			org: 'acme',
			registration: REPO,
			scriptRegistration: 'HAPRM',
			named: false,
			previewBaseUrl: 'http://127.0.0.1:6001',
			sealedHost: HOST,
			...over
		});

	it('is bound to the loopback, so a sign-in saved on one preview port opens a run on another', () => {
		expect(bindBaseFor(REPO, 'http://127.0.0.1:5301')).toBe(LOOPBACK_BIND);
		expect(profileKey(bindBaseFor(REPO, 'http://127.0.0.1:5301'))).not.toMatch(/\d{4}/);
		save('HAPRM', COOKIE_STATE);
		expect(choose({ previewBaseUrl: 'http://127.0.0.1:6002' }).state).toEqual(COOKIE_STATE);
		expect(choose({ previewBaseUrl: 'http://127.0.0.1:6003' }).state).toEqual(COOKIE_STATE);
	});

	it('moves the loopback origins of a local storage session to the preview the run started', () => {
		save('HAPRM', LOCAL_STATE);
		const got = choose({ previewBaseUrl: 'http://127.0.0.1:6002' }).state as {
			origins: { origin: string }[];
		};
		expect(got.origins[0]?.origin).toBe('http://127.0.0.1:6002');
		expect(retargetOrigins(LOCAL_STATE, 'http://127.0.0.1:6002')).not.toBe(LOCAL_STATE);
		// A cookie-only state and a foreign origin are left as they are
		expect(
			retargetOrigins(
				{ cookies: [], origins: [{ origin: 'https://x.test' }] },
				'http://127.0.0.1:1'
			)
		).toEqual({ cookies: [], origins: [{ origin: 'https://x.test' }] });
	});

	it('is never used by another registration of the same folder, even with the same sealed project', () => {
		save('HAPRM', COOKIE_STATE);
		expect(choose({ registration: OTHER, scriptRegistration: 'HAPRN' }).state).toBeNull();
	});

	it('is not used on another sealed test project, and says why', () => {
		save('HAPRM', COOKIE_STATE);
		const c = choose({ sealedHost: 'other.supabase.co' });
		expect(c.state).toBeNull();
		expect(c.note).toMatch(/made on proj\.supabase\.co, but this run uses other\.supabase\.co/);
		expect(c.failure).toBeNull();
	});

	it('does not open a run signed in when the script does not name the registration, unless the person named it', () => {
		save('HAPRM', COOKIE_STATE);
		expect(choose({ scriptRegistration: null }).state).toBeNull();
		expect(choose({ scriptRegistration: null, named: true }).state).toEqual(COOKIE_STATE);
	});

	it('uses no saved sign-in on a throwaway database', () => {
		save('HAPRM', COOKIE_STATE);
		expect(choose({ throwawayDatabase: true }).state).toBeNull();
	});

	it('keeps a named profile apart from the default and from other names', () => {
		save('HAPRM', { cookies: [{ name: 'a', value: '1', domain: '127.0.0.1' }], origins: [] });
		save(
			'HAPRM',
			{ cookies: [{ name: 'b', value: '2', domain: '127.0.0.1' }], origins: [] },
			'read-only'
		);
		const a = choose().state as { cookies: { name: string }[] };
		const b = choose({ profile: 'read-only', named: true }).state as {
			cookies: { name: string }[];
		};
		expect(a.cookies[0]?.name).toBe('a');
		expect(b.cookies[0]?.name).toBe('b');
		const listed = listProfiles('acme', 'HAPRM')
			.map((e) => e.profile)
			.sort();
		expect(listed).toEqual(['default', 'read-only']);
	});

	it('fails a named profile that is missing, made on another project or expired, and never signs in as another', () => {
		const missing = choose({ profile: 'read-only', named: true });
		expect(missing.state).toBeNull();
		expect(missing.failure).toMatch(/no saved sign-in named "read-only" for HAPRM/);
		save('HAPRM', COOKIE_STATE, 'read-only');
		expect(
			choose({ profile: 'read-only', named: true, sealedHost: 'x.supabase.co' }).failure
		).toMatch(/was made on proj\.supabase\.co, but this run uses x\.supabase\.co/);
		save(
			'HAPRM',
			{ cookies: [{ name: 's', value: 'v', domain: '127.0.0.1', expires: 1 }], origins: [] },
			'old'
		);
		expect(choose({ profile: 'old', named: true }).failure).toMatch(/has expired/);
	});

	it('an expired default sign-in only says so', () => {
		save('HAPRM', {
			cookies: [{ name: 's', value: 'v', domain: '127.0.0.1', expires: 1 }],
			origins: []
		});
		const c = choose();
		expect(c.failure).toBeNull();
		expect(c.note).toMatch(/expired/);
	});

	it('forgets one profile and leaves the others', () => {
		save('HAPRM', COOKIE_STATE);
		save('HAPRM', COOKIE_STATE, 'read-only');
		expect(removeProfilesNamed('acme', 'HAPRM', 'read-only')).toBe(1);
		expect(listProfiles('acme', 'HAPRM').map((e) => e.profile)).toEqual(['default']);
	});
});

describe('profile names and the script header', () => {
	it('accepts default and plain lower case names, never a path', () => {
		expect(assertProfileName('default')).toBe('default');
		expect(assertProfileName('read-only')).toBe('read-only');
		for (const bad of ['../x', 'A', 'a b', '', 'x'.repeat(33), 'a/b'])
			expect(() => assertProfileName(bad)).toThrow(/profile name/);
	});
	it('reads "// afb-profile:" only among the first 12 lines', () => {
		expect(profileHeader('// afb-profile: read-only\nexport default 1')).toBe('read-only');
		const late = [...Array(12).fill('//'), '// afb-profile: read-only'].join('\n');
		expect(profileHeader(late)).toBeNull();
		expect(profileHeader('// afb-profile: Bad Name')).toBeNull();
	});
	it('the sealed key of a preview is its sorted hosts, or null', () => {
		expect(sealedKey(['b.co', 'a.co'])).toBe('a.co,b.co');
		expect(sealedKey([])).toBeNull();
		expect(sealedKey(undefined)).toBeNull();
	});
});
