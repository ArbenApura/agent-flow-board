// A SIGN IN OLDER THAN A DAY: THE SETTINGS SESSION LIST IS REFUSED BY BETTER AUTH, AND THE PAGE MUST STILL OPEN (AFB-20261114-1155)

// IMPORTED DEP-MODULES
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// IMPORTED MODULES
import { createAuth, type Auth } from '../../src/lib/server/auth/auth';
import { isNotFresh, listOrStale } from '../../src/lib/server/auth/fresh';
import { registerAccount } from '../../src/lib/server/auth/register';
import { authSession } from '../../src/lib/server/db/schema';
import { createMailer, outbox } from '../../src/lib/server/email/mailer';
import { makePostgres, type TestDb } from '../support/db';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';
const PASSWORD = 'a long enough password';

// -- FUNCTIONS -- //

describe('a sign in older than the fresh age', () => {
	let db: TestDb;
	let auth: Auth;

	beforeAll(async () => {
		db = await makePostgres();
		auth = createAuth({
			handle: db,
			mailer: createMailer({ provider: 'log', from: 'board@example.com' }),
			config: {
				secret: 'f'.repeat(40),
				baseUrl: BASE,
				checkBreachedPasswords: false,
				disableRateLimit: true
			}
		});
	}, 120_000);

	afterAll(async () => {
		await db.stop();
	});

	/** Signs a new person in and gives the cookie header of that session. */
	async function signedIn() {
		const email = `fresh-${Date.now()}@example.com`;
		await registerAccount(auth, { email, password: PASSWORD, name: 'Fresh Person' });
		const mail = [...outbox].reverse().find((m) => m.to === email);
		const link = /(https?:\/\/\S+)/.exec(mail?.text ?? '')?.[1] ?? '';
		await auth.handler(new Request(link));
		const res = await auth.handler(
			new Request(`${BASE}/api/auth/sign-in/email`, {
				method: 'POST',
				headers: new Headers({ 'content-type': 'application/json', origin: BASE }),
				body: JSON.stringify({ email, password: PASSWORD })
			})
		);
		expect(res.status).toBe(200);
		const cookie = res.headers
			.getSetCookie()
			.map((c) => c.split(';')[0])
			.join('; ');
		return new Headers({ cookie });
	}

	it('lists sessions while the sign in is fresh', async () => {
		const headers = await signedIn();
		const out = await listOrStale(() => auth.api.listSessions({ headers }));
		expect(out.stale).toBe(false);
		// The verification link and the sign in each start a session, so at least one is listed
		expect(out.rows.length).toBeGreaterThan(0);
	});

	it('is reported as stale, not thrown, once the sign in is older than a day', async () => {
		const headers = await signedIn();
		// Backdating the row in this throwaway test database stands in for waiting two days
		await db.db.update(authSession).set({ createdAt: new Date(Date.now() - 2 * 86_400_000) });
		await expect(auth.api.listSessions({ headers })).rejects.toSatisfy(isNotFresh);
		const out = await listOrStale(() => auth.api.listSessions({ headers }));
		expect(out).toEqual({ rows: [], stale: true });
	});

	it('throws every other error again', async () => {
		await expect(
			listOrStale(() => Promise.reject(new Error('the database is down')))
		).rejects.toThrow('the database is down');
		expect(isNotFresh({ body: { code: 'UNAUTHORIZED' } })).toBe(false);
		expect(isNotFresh({ body: { message: 'Session is not fresh' } })).toBe(false);
		expect(isNotFresh(null)).toBe(false);
	});
});

describe('the sign out route', () => {
	async function signOutTo(query: string) {
		vi.resetModules();
		vi.doMock('#lib/server/auth/index.js', () => ({
			getAuth: async () => ({ api: { signOut: async () => ({}) } })
		}));
		const { POST } = await import('../../src/routes/sign-out/+server');
		try {
			await POST({
				request: new Request(`${BASE}/sign-out${query}`, { method: 'POST' }),
				url: new URL(`${BASE}/sign-out${query}`)
			} as Parameters<typeof POST>[0]);
		} catch (e) {
			return (e as { location: string }).location;
		}
		throw new Error('sign out did not redirect');
	}

	it('keeps a path on this site as the place to come back to', async () => {
		expect(await signOutTo('?next=/settings')).toBe('/sign-in?next=%2Fsettings');
	});

	it('drops an address on another site', async () => {
		expect(await signOutTo('?next=//evil.example')).toBe('/sign-in');
		expect(await signOutTo('')).toBe('/sign-in');
	});
});
