// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { needlesFromEnv, redact, redactPatterns } from './redact.js';

const PASSWORD = 'correct-horse-battery';

describe('redact needles', () => {
	it('removes a needle in its raw form', () => {
		expect(redact(`login with ${PASSWORD} now`, [PASSWORD])).toBe('login with [hidden] now');
	});

	it('removes a needle in its URL-encoded form', () => {
		const needle = 'p@ss word/with&odd=chars';
		expect(redact(`GET /x?pw=${encodeURIComponent(needle)}`, [needle])).toBe('GET /x?pw=[hidden]');
	});

	it('removes a needle in its base64 form, padded or not', () => {
		const b64 = Buffer.from(PASSWORD).toString('base64');
		expect(redact(`Basic ${b64}`, [PASSWORD])).not.toContain(b64);
		expect(redact(`x ${b64.replace(/=+$/, '')} y`, [PASSWORD])).toBe('x [hidden] y');
	});

	it('ignores needles shorter than 6 characters', () => {
		expect(redact('the pass is abc12 ok', ['abc12', ''])).toBe('the pass is abc12 ok');
		expect(redact('abcdef', ['abcdef'])).toBe('[hidden]');
	});

	it('removes every occurrence and keeps the rest of the text', () => {
		expect(redact(`${PASSWORD} and ${PASSWORD}`, [PASSWORD])).toBe('[hidden] and [hidden]');
	});
});

describe('redactPatterns', () => {
	it('masks bearer tokens', () => {
		expect(redactPatterns('Authorization header Bearer abcdefghijklmnop1234')).not.toContain(
			'abcdefghijklmnop1234'
		);
	});

	it('masks afx_ and afb_ prefixed tokens', () => {
		const out = redactPatterns(
			'token afx_abcdefghijklmnopqrstuvwx and afb_0123456789abcdefghij end'
		);
		expect(out).toBe('token [hidden] and [hidden] end');
	});

	it('masks JWT-looking strings', () => {
		const jwt =
			'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
		expect(redactPatterns(`jwt=${jwt};`)).not.toContain('eyJhbGci');
	});

	it('hides the password of a postgres url but keeps the rest', () => {
		expect(redactPatterns('postgres://app:s3cret@db.example.com:5432/x')).toBe(
			'postgres://app:[hidden]@db.example.com:5432/x'
		);
	});

	it('leaves plain text alone', () => {
		expect(redactPatterns('Step 3 passed in 1.2s')).toBe('Step 3 passed in 1.2s');
	});

	it('is applied by redact too', () => {
		expect(redact('Bearer abcdefghijklmnop1234', [])).toBe('[hidden]');
	});
});

describe('needlesFromEnv', () => {
	it('takes values of secret-looking names that are 8+ characters', () => {
		const needles = needlesFromEnv({
			DB_PASSWORD: 'hunter2hunter2',
			API_TOKEN: 'tok-1234567890',
			DATABASE_URL: 'postgres://u:p@h/db',
			SHORT_KEY: 'abc',
			PATH: '/usr/bin:/bin:/usr/local/bin',
			NODE_ENV: 'production-mode'
		});
		expect(needles.sort()).toEqual(
			['hunter2hunter2', 'postgres://u:p@h/db', 'tok-1234567890'].sort()
		);
	});
});
