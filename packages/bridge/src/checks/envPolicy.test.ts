// THE PREVIEW ENVIRONMENT: DATABASE AND MAIL VARIABLES STRIPPED, THE REST ADOPTED, THE RUN'S OWN SETTINGS KEPT, AND NO VALUE IN ANY NOTE

// -- DEP-MODULES -- //
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { buildAdoptedEnv, buildPreviewEnv, parseEnvText } from './envPolicy.js';

// -- FUNCTIONS -- //

describe('buildPreviewEnv', () => {
	let repo = '';
	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), 'afb-env-'));
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	const base = () => ({ repo, recipeEnv: {}, port: 41234, baseUrl: 'http://127.0.0.1:41234' });

	it('parses plain lines without expansion or substitution', () => {
		const m = parseEnvText(
			'# c\nexport A=1\nB="two words"\nC=$(whoami)\nD=${A}\nE=x # note\nF="a\nb"\n'
		);
		expect(m.get('A')).toBe('1');
		expect(m.get('B')).toBe('two words');
		expect(m.get('C')).toBe('$(whoami)');
		expect(m.get('D')).toBe('${A}');
		expect(m.get('E')).toBe('x');
		expect(m.get('F')).toBe('a\nb');
	});

	it('strips a database url and a mail token, keeps an unrelated variable, and names no value', () => {
		writeFileSync(
			join(repo, '.env'),
			[
				'DATABASE_URL=postgres://u:supersecretpw@db.example.com:5432/app',
				'DATABASE_OWNER_URL=postgres://o:ownersecretpw@db.example.com:5432/app',
				'POSTMARK_TOKEN=pm-token-value-123',
				'MAIL_FROM=a@example.com',
				'SOME_CONN=redis://:redispassword@cache.example.com:6379',
				'SESSION_SECRET=keep-this-session-secret',
				'PUBLIC_TITLE=Hello',
				'ORIGIN=https://live.example.com',
				'BETTER_AUTH_URL=https://live.example.com',
				'PORT=9999',
				'NODE_ENV=development',
				'EMAIL_PROVIDER=postmark'
			].join('\n')
		);
		writeFileSync(join(repo, '.env.local'), 'PUBLIC_TITLE=Local\n');
		const r = buildPreviewEnv(base());
		expect(r.stripped.sort()).toEqual([
			'DATABASE_OWNER_URL',
			'DATABASE_URL',
			'MAIL_FROM',
			'POSTMARK_TOKEN',
			'SOME_CONN'
		]);
		for (const k of r.stripped) expect(r.env[k]).toBeUndefined();
		expect(r.env.SESSION_SECRET).toBe('keep-this-session-secret');
		expect(r.env.PUBLIC_TITLE).toBe('Local');
		expect(r.env.ORIGIN).toBe('http://127.0.0.1:41234');
		expect(r.env.BETTER_AUTH_URL).toBe('http://127.0.0.1:41234');
		expect(r.env.PORT).toBe('41234');
		expect(r.env.HOST).toBe('127.0.0.1');
		expect(r.env.NODE_ENV).toBe('production');
		expect(r.env.EMAIL_PROVIDER).toBe('log');
		expect(r.env.DATABASE_URL).toBeUndefined();
		const text = r.notes.join('\n');
		for (const secret of [
			'supersecretpw',
			'pm-token-value-123',
			'keep-this-session-secret',
			'redispassword',
			'live.example.com'
		])
			expect(text).not.toContain(secret);
		expect(text).toContain('POSTMARK_TOKEN');
	});

	it('sets the database urls only when given, and resolves the recipe placeholders', () => {
		const r = buildPreviewEnv({
			...base(),
			databaseUrl: 'postgresql://app:pw@127.0.0.1:50000/app',
			databaseOwnerUrl: 'postgresql://postgres:pw@127.0.0.1:50000/app',
			recipeEnv: { AUTH_SECRET: '{random}', SELF: '{baseUrl}/x', P: '{port}', RO: '{databaseUrl}' }
		});
		expect(r.env.DATABASE_URL).toBe('postgresql://app:pw@127.0.0.1:50000/app');
		expect(r.env.DATABASE_OWNER_URL).toBe('postgresql://postgres:pw@127.0.0.1:50000/app');
		expect(r.env.AUTH_SECRET).toMatch(/^[0-9a-f]{48}$/);
		expect(r.env.SELF).toBe('http://127.0.0.1:41234/x');
		expect(r.env.P).toBe('41234');
		expect(r.env.RO).toBe(r.env.DATABASE_URL);
		const none = buildPreviewEnv({ ...base(), recipeEnv: { RO: '{databaseUrl}' } });
		expect(none.env.RO).toBe('');
		expect(none.env.DATABASE_URL).toBeUndefined();
		expect(none.notes.join(' ')).toContain('RO');
	});

	it('passes only the system variables of the process, never a token or secret', () => {
		const keep = { t: process.env.AFB_TOKEN, k: process.env.MY_API_KEY, s: process.env.MY_SECRET };
		process.env.AFB_TOKEN = 'tok-123456789';
		process.env.MY_API_KEY = 'key-123456789';
		process.env.MY_SECRET = 'sec-123456789';
		try {
			const r = buildPreviewEnv(base());
			expect(r.env.AFB_TOKEN).toBeUndefined();
			expect(r.env.MY_API_KEY).toBeUndefined();
			expect(r.env.MY_SECRET).toBeUndefined();
			expect(Object.entries(r.env).some(([, v]) => v.includes('123456789'))).toBe(false);
			expect(Object.keys(r.env).some((k) => k.toUpperCase() === 'PATH')).toBe(true);
		} finally {
			for (const [name, v] of [
				['AFB_TOKEN', keep.t],
				['MY_API_KEY', keep.k],
				['MY_SECRET', keep.s]
			] as const) {
				if (v === undefined) delete process.env[name];
				else process.env[name] = v;
			}
		}
	});

	it('works with no env files at all', () => {
		const r = buildPreviewEnv(base());
		expect(r.stripped).toEqual([]);
		expect(r.env.PORT).toBe('41234');
	});
});

// -- THE ADOPTED ENVIRONMENT -- //

describe('buildAdoptedEnv', () => {
	let repo = '';
	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), 'afb-adopt-'));
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));
	const base = () => ({ repo, recipeEnv: {}, port: 41234, baseUrl: 'http://127.0.0.1:41234' });

	it('adopts the whole .env for the start step only, never for the build', () => {
		writeFileSync(
			join(repo, '.env'),
			'SESSION_SECRET=keep-this-session-secret\nPUBLIC_TITLE=Hello\nORIGIN=https://live.example.com\n'
		);
		const r = buildAdoptedEnv(base());
		expect(r.env.SESSION_SECRET).toBe('keep-this-session-secret');
		expect(r.buildEnv.SESSION_SECRET).toBeUndefined();
		expect(r.buildEnv.PUBLIC_TITLE).toBeUndefined();
		expect(r.env.ORIGIN).toBe('http://127.0.0.1:41234');
		expect(r.env.PORT).toBe('41234');
		expect(r.env.EMAIL_PROVIDER).toBe('log');
		expect(r.problems).toEqual([]);
		expect(r.redactions).toContain('keep-this-session-secret');
		expect(r.notes.join('\n')).not.toContain('keep-this-session-secret');
	});

	it('lets the recipe and the run win over the file, and drops the deny list', () => {
		writeFileSync(
			join(repo, '.env'),
			'AFB_X=file\nNODE_OPTIONS=--require evil.js\nPATH=/evil\nPORT=1\n'
		);
		const r = buildAdoptedEnv({ ...base(), recipeEnv: { AFB_X: 'recipe' } });
		expect(r.env.AFB_X).toBe('recipe');
		expect(r.env.NODE_OPTIONS).toBeUndefined();
		expect(r.env.PATH).not.toBe('/evil');
		expect(r.notes.join(' ')).toContain('NODE_OPTIONS');
	});

	it('fails the run for a database value on 5433 and names the variable, not the value', () => {
		writeFileSync(
			join(repo, '.env'),
			'DATABASE_URL=postgres://u:hunter2hunter2@localhost:5433/app\n'
		);
		const r = buildAdoptedEnv({
			...base(),
			databaseUrl: 'postgresql://app:pw@127.0.0.1:50000/app'
		});
		expect(r.problems).toHaveLength(1);
		expect(r.problems[0]).toContain('DATABASE_URL');
		expect(r.problems.join(' ') + r.notes.join(' ')).not.toContain('hunter2hunter2');
		// The run's own throwaway database still wins in the environment, but the run is refused by the caller
		expect(r.env.DATABASE_URL).toBe('postgresql://app:pw@127.0.0.1:50000/app');
	});

	it('allows the sealed test host and refuses a production host', () => {
		writeFileSync(join(repo, '.env'), 'SUPABASE_URL=https://testref12.supabase.co\n');
		expect(buildAdoptedEnv({ ...base(), testHost: 'testref12.supabase.co' }).problems).toEqual([]);
		expect(buildAdoptedEnv(base()).problems).toHaveLength(1);
	});

	it('keeps only sealed mail settings', () => {
		writeFileSync(
			join(repo, '.env'),
			'POSTMARK_SERVER_TOKEN=live-token-123456\nSMTP_HOST=smtp.example.com\nKEEP=1\n'
		);
		const r = buildAdoptedEnv({ ...base(), sealedNames: ['POSTMARK_SERVER_TOKEN'] });
		expect(r.env.POSTMARK_SERVER_TOKEN).toBe('live-token-123456');
		expect(r.env.SMTP_HOST).toBeUndefined();
		expect(r.stripped).toEqual(['SMTP_HOST']);
		expect(r.env.KEEP).toBe('1');
	});

	it('leaves the stricter default untouched for a registration that did not opt in', () => {
		writeFileSync(
			join(repo, '.env'),
			'DATABASE_URL=postgres://u:p@db.example.com:5432/app\nKEEP=1\n'
		);
		const r = buildPreviewEnv(base());
		expect(r.stripped).toEqual(['DATABASE_URL']);
		expect(r.env.KEEP).toBe('1');
	});
});
