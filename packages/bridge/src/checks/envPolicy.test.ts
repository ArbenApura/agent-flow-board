// THE PREVIEW ENVIRONMENT: DATABASE AND MAIL VARIABLES STRIPPED, THE REST ADOPTED, THE RUN'S OWN SETTINGS KEPT, AND NO VALUE IN ANY NOTE

// -- DEP-MODULES -- //
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { buildPreviewEnv, parseEnvText } from './envPolicy.js';

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
