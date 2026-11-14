// TESTS OF THE DATABASE RULE OF AN ADOPTED ENVIRONMENT: EVERY SPELLING OF THE LOCAL DATABASE AND THE PERSON'S SERVER PORTS IS REFUSED, A SEALED TEST HOST IS ALLOWED, NO VALUE IS NAMED

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { databaseProblems, expandRefs, isLoopbackHost, normalizeHost } from './envrules.js';

// -- CONSTANTS -- //

const TEST_HOST = 'testref12.supabase.co';
const THROWAWAY = '127.0.0.1:50123';

// -- FUNCTIONS -- //

const names = (env: Record<string, string>, opts = {}) =>
	databaseProblems(env, opts).map((s) => s.split(' ')[0]);

describe('databaseProblems: the local database on 5433 in every spelling', () => {
	const hosts = [
		'host.docker.internal',
		'localhost',
		'127.0.0.1',
		'[::1]',
		'0.0.0.0',
		'LOCALHOST',
		'127.1',
		'2130706433',
		'0x7f.0.0.1',
		'localhost.',
		'db.localhost',
		'[::ffff:127.0.0.1]',
		'[0:0:0:0:0:0:0:1]',
		'[::]'
	];
	for (const host of hosts)
		it(`refuses postgres://u:p@${host}:5433/app`, () => {
			const env = { DATABASE_URL: `postgres://u:pw-secret-9@${host}:5433/app` };
			expect(names(env)).toEqual(['DATABASE_URL']);
			expect(databaseProblems(env).join(' ')).not.toContain('pw-secret-9');
		});

	it('refuses the person servers 5180 and 5190 and the database 5433 on any variable name', () => {
		for (const port of [5180, 5190, 5433]) {
			expect(names({ API_BASE: `http://localhost:${port}/api` })).toEqual(['API_BASE']);
			expect(names({ SOMETHING: `127.0.0.1:${port}` })).toEqual(['SOMETHING']);
		}
	});

	it('allows another local port that is not a database variable', () => {
		expect(
			databaseProblems({ API_BASE: 'http://localhost:3000/api', SOME_URL: 'http://127.0.0.1:8080' })
		).toEqual([]);
	});

	it('completes an elided port from PGPORT', () => {
		expect(names({ DATABASE_URL: 'postgres://u:p@localhost/app', PGPORT: '5433' })).toEqual(
			expect.arrayContaining(['DATABASE_URL'])
		);
		expect(names({ DATABASE_URL: 'postgres://u:p@localhost/app', PGPORT: '5433' })).toContain(
			'DATABASE_URL'
		);
	});

	it('completes an elided port from a sibling *_PORT of the same prefix', () => {
		const env = { APP_DB_URL: 'postgres://u:p@127.0.0.1/app', APP_DB_PORT: '5433' };
		expect(names(env)).toContain('APP_DB_URL');
		const host = { DB_HOST: 'localhost', DB_PORT: '5433' };
		expect(names(host)).toEqual(expect.arrayContaining(['DB_HOST', 'DB_PORT']));
		const redis = { REDIS_URL: 'redis://localhost', REDIS_PORT: '5190' };
		expect(names(redis)).toContain('REDIS_URL');
	});

	it('reads ?port= and ?host= parameters', () => {
		expect(names({ DATABASE_URL: 'postgres://u:p@localhost/app?port=5433' })).toEqual([
			'DATABASE_URL'
		]);
		expect(names({ DATABASE_URL: 'postgres:///app?host=localhost&port=5433' })).toEqual([
			'DATABASE_URL'
		]);
		expect(names({ DATABASE_URL: 'postgres:///app?host=host.docker.internal&port=5433' })).toEqual([
			'DATABASE_URL'
		]);
	});

	it('reads a URL-encoded value, also encoded twice', () => {
		const url = 'postgres://u:p@localhost:5433/app';
		expect(names({ DATABASE_URL: encodeURIComponent(url) })).toEqual(['DATABASE_URL']);
		expect(names({ DATABASE_URL: encodeURIComponent(encodeURIComponent(url)) })).toEqual([
			'DATABASE_URL'
		]);
		expect(names({ DATABASE_URL: 'postgres://u:p@local%68ost:5433/app' })).toEqual([
			'DATABASE_URL'
		]);
	});

	it('expands ${VAR} before it reads the value, nested and with a default', () => {
		const env = {
			PGHOSTX: 'localhost',
			DATABASE_URL: 'postgres://u:p@${PGHOSTX}:${DBP}/app',
			DBP: '${INNER}',
			INNER: '5433'
		};
		expect(names(env)).toContain('DATABASE_URL');
		expect(names({ DATABASE_URL: 'postgres://u:p@localhost:${MISSING:-5433}/app' })).toEqual([
			'DATABASE_URL'
		]);
		expect(expandRefs('a${X}b', { X: '1' })).toBe('a1b');
		expect(expandRefs('a${NOPE}b', {})).toBe('ab');
	});

	it('compares names and spellings without case', () => {
		expect(names({ database_url: 'POSTGRES://U:P@LocalHost:5433/APP' })).toEqual(['database_url']);
		expect(names({ Db_Host: 'LOCALHOST', db_port: '5433' })).toContain('Db_Host');
	});

	it('refuses a mongodb host list and a user name with the port in it only on the right host', () => {
		expect(
			databaseProblems({ MONGO_URL: 'mongodb://localhost:1,localhost:5433/x' }).join(' ')
		).toContain('port 5433');
		expect(
			names(
				{ DATABASE_URL: 'postgres://localhost:5433@db.example.com/x' },
				{ testHost: 'db.example.com' }
			)
		).toEqual([]);
	});
});

describe('databaseProblems: remote hosts', () => {
	it('refuses a remote production database and names the variable only', () => {
		const env = { DATABASE_URL: 'postgres://u:real-password-77@db.prod.example.com:5432/app' };
		const p = databaseProblems(env, { testHost: TEST_HOST, throwawayHost: THROWAWAY });
		expect(p).toHaveLength(1);
		expect(p[0]).toContain('DATABASE_URL');
		expect(p.join(' ')).not.toContain('real-password-77');
		expect(p.join(' ')).not.toContain('db.prod.example.com');
	});

	it('refuses a production Supabase host and a connection string under an unrelated name', () => {
		expect(
			names({ PUBLIC_SUPABASE_URL: 'https://prodproj.supabase.co' }, { testHost: TEST_HOST })
		).toEqual(['PUBLIC_SUPABASE_URL']);
		expect(
			names({ THING: 'https://prodproj.supabase.co/rest/v1' }, { testHost: TEST_HOST })
		).toEqual(['THING']);
		expect(names({ CACHE: 'redis://:pw@cache.example.com:6379' })).toEqual(['CACHE']);
	});

	it('allows the sealed test host in a URL and as a bare host', () => {
		const env = {
			PUBLIC_SUPABASE_URL: `https://${TEST_HOST}`,
			SUPABASE_URL: `https://${TEST_HOST.toUpperCase()}/`,
			DATABASE_URL: `postgres://postgres:pw@db.${TEST_HOST}:5432/postgres`.replace('db.', '')
		};
		expect(databaseProblems(env, { testHost: TEST_HOST })).toEqual([]);
		expect(names({ PGHOST: TEST_HOST }, { testHost: TEST_HOST })).toEqual([]);
		expect(names({ PGHOST: 'other.example.com' }, { testHost: TEST_HOST })).toEqual(['PGHOST']);
	});

	it('allows the run own throwaway database (host or host:port) and refuses another local one', () => {
		const own = {
			DATABASE_URL: 'postgresql://app:pw@127.0.0.1:50123/app',
			DATABASE_OWNER_URL: 'postgresql://o:pw@localhost:50123/app'
		};
		expect(databaseProblems(own, { throwawayHost: THROWAWAY })).toEqual([]);
		expect(
			names(
				{ DATABASE_URL: 'postgresql://app:pw@127.0.0.1:5432/app' },
				{ throwawayHost: THROWAWAY }
			)
		).toEqual(['DATABASE_URL']);
		expect(names({ DATABASE_URL: 'postgresql://app:pw@127.0.0.1:50123/app' })).toEqual([
			'DATABASE_URL'
		]);
		expect(
			databaseProblems(
				{ DATABASE_URL: 'postgresql://app:pw@127.0.0.1:50123/app' },
				{ throwawayHost: '127.0.0.1' }
			)
		).toEqual([]);
	});

	it('leaves ordinary variables alone', () => {
		const env = {
			PUBLIC_TITLE: 'Hello',
			STRIPE_URL: 'https://api.stripe.com/v1',
			SENTRY_DSN: 'https://key@o1.ingest.sentry.io/123',
			DB_NAME: 'app',
			DATABASE_PASSWORD: 'x',
			FEEDBACK_URL: 'https://feedback.example.com',
			SESSION_SECRET: 'abc'
		};
		expect(databaseProblems(env)).toEqual([]);
	});

	it('refuses a lone database port variable at a forbidden port', () => {
		expect(names({ PGPORT: '5433' })).toEqual(['PGPORT']);
		expect(names({ DB_PORT: '5432' })).toEqual([]);
	});
});

describe('host helpers', () => {
	it('folds spellings of the loopback address', () => {
		for (const h of [
			'localhost',
			'LocalHost.',
			'127.0.0.1',
			'127.9.9.9',
			'[::1]',
			'::1',
			'0.0.0.0',
			'host.docker.internal',
			'2130706433',
			'0x7f.1'
		])
			expect(isLoopbackHost(h), h).toBe(true);
		for (const h of ['example.com', '10.0.0.5', '8.8.8.8', 'db.supabase.co', '[2001:db8::1]', ''])
			expect(isLoopbackHost(h), h).toBe(false);
		expect(normalizeHost('[::1]')).toBe('::1');
		expect(normalizeHost('Example.COM.')).toBe('example.com');
	});
});

describe('databaseProblems: key/value connection strings and IPv6 host names (S8)', () => {
	for (const dsn of [
		'host=localhost port=5433 dbname=app user=u password=pw-secret-9',
		"host='localhost' port='5433'",
		'dbname=app host=127.0.0.1 port=5433',
		'hostaddr=127.0.0.1 port=5433',
		'host=ip6-localhost port=5433',
		'host=ip6-loopback port=5433',
		'host=db.example.com,localhost port=5432,5433'
	])
		it(`refuses ${dsn.replace(/pw-secret-9/, '***')}`, () => {
			const env = { APP_DB: dsn };
			expect(new Set(names(env))).toEqual(new Set(['APP_DB']));
			expect(databaseProblems(env).join(' ')).not.toContain('pw-secret-9');
		});

	it('knows the IPv6 host names as this machine', () => {
		expect(isLoopbackHost('ip6-localhost')).toBe(true);
		expect(isLoopbackHost('ip6-loopback')).toBe(true);
		expect(isLoopbackHost('IP6-LOCALHOST.')).toBe(true);
	});

	it('allows a key/value string that names the sealed test host', () => {
		expect(
			databaseProblems(
				{ APP_DB: `host=${TEST_HOST} port=5432 dbname=app` },
				{ testHost: TEST_HOST }
			)
		).toEqual([]);
	});
});
