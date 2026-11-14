// `check project profiles` AND `check project forget --profile`: LISTING AND REMOVING A REGISTRATION'S SAVED SIGN-INS WITHOUT EVER SHOWING A VALUE

// IMPORTED DEP-MODULES
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { projectCommand } from './commands.js';
import { listProfiles, profileKey, saveProfile } from './profiles.js';

// -- FUNCTIONS -- //

describe('project profiles', () => {
	let base = '';
	let saved: string | undefined;
	let out: string[] = [];
	const ctx = () => ({
		json: false,
		out: (l: string) => out.push(l),
		log: (l: string) => out.push(l)
	});

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), 'afb-profiles-'));
		saved = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'home');
		out = [];
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = saved;
		rmSync(base, { recursive: true, force: true });
	});

	const state = {
		cookies: [{ name: 'sb', value: 'cookie-secret', domain: '127.0.0.1' }],
		origins: []
	};

	it('lists names, dates and the test project, never a cookie value', async () => {
		saveProfile('acme', 'HAPRM', '127.0.0.1', state, {
			profile: 'default',
			sealedHost: 'p.supabase.co'
		});
		saveProfile('acme', 'HAPRM', profileKey('127.0.0.1', 'read-only'), state, {
			profile: 'read-only',
			sealedHost: 'p.supabase.co'
		});
		expect(await projectCommand(['profiles', 'HAPRM', '--org', 'acme'], ctx())).toBe(0);
		const text = out.join('\n');
		expect(text).toMatch(/default {2}saved .* on 127\.0\.0\.1 {2}test project p\.supabase\.co/);
		expect(text).toMatch(/read-only {2}saved/);
		expect(text).not.toContain('cookie-secret');
	});

	it('says so when a registration has none', async () => {
		expect(await projectCommand(['profiles', 'NOPE', '--org', 'acme'], ctx())).toBe(0);
		expect(out.join('\n')).toMatch(/has no saved sign-ins/);
	});

	it('forgets one profile and leaves the rest, and refuses a bad name', async () => {
		saveProfile('acme', 'HAPRM', '127.0.0.1', state, { profile: 'default' });
		saveProfile('acme', 'HAPRM', profileKey('127.0.0.1', 'read-only'), state, {
			profile: 'read-only'
		});
		expect(
			await projectCommand(['forget', 'HAPRM', '--org', 'acme', '--profile', 'read-only'], ctx())
		).toBe(0);
		expect(out.join('\n')).toMatch(/Removed the saved sign-in "read-only"/);
		expect(listProfiles('acme', 'HAPRM').map((e) => e.profile)).toEqual(['default']);
		out = [];
		expect(
			await projectCommand(['forget', 'HAPRM', '--org', 'acme', '--profile', '../x'], ctx())
		).not.toBe(0);
		expect(listProfiles('acme', 'HAPRM')).toHaveLength(1);
	});
});
