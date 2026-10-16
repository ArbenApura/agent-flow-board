// 4.3 TO 4.6: SIGN UP, VERIFY, SIGN IN, RESET, LOCKOUT, NEW DEVICE ALERTS AND THE UNVERIFIED DUPLICATE RULE, ON PGLITE

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import { createAuth, type Auth } from '../../src/lib/server/auth/auth';
import { registerAccount, resendVerification } from '../../src/lib/server/auth/register';
import { MAX_FAILURES, lockMinutes } from '../../src/lib/server/auth/lockout';
import { purgeUnverifiedDuplicate } from '../../src/lib/server/auth/unverified';
import { authAccount, authLockout, user } from '../../src/lib/server/db/schema';
import { createMailer, outbox } from '../../src/lib/server/email/mailer';
import { makePglite, type TestDb } from '../support/db';

// -- CONSTANTS -- //

const BASE = 'http://localhost:5180';
const PASSWORD = 'a long enough password';
const headers = (
	ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/150.0 Safari/537.36',
	ip = '203.0.113.9'
) => new Headers({ 'user-agent': ua, 'x-forwarded-for': ip });

// -- FUNCTIONS -- //

describe('authentication', () => {
	let db: TestDb;
	let auth: Auth;
	const mailer = createMailer({
		provider: 'log',
		from: 'board@example.com',
		failPattern: '^fail@'
	});
	let counter = 0;
	const fresh = () => `person${++counter}-${Date.now()}@example.com`;

	beforeAll(async () => {
		db = await makePglite();
		auth = createAuth({
			handle: db,
			mailer,
			config: {
				secret: 'x'.repeat(40),
				baseUrl: BASE,
				checkBreachedPasswords: false,
				disableRateLimit: true
			}
		});
	}, 120_000);
	afterAll(async () => {
		await db.stop();
	});
	beforeEach(() => {
		outbox.length = 0;
	});

	const lastMailTo = (email: string) => [...outbox].reverse().find((m) => m.to === email);
	const linkIn = (text: string) => /(https?:\/\/\S+)/.exec(text)?.[1] ?? '';

	async function signUp(email: string, name = 'Test Person') {
		const r = await registerAccount(auth, { email, password: PASSWORD, name, headers: headers() });
		if (!r.ok && r.code !== 'EMAIL_FAILED') throw new Error(r.message);
		return r;
	}
	async function verify(email: string) {
		const mail = lastMailTo(email);
		expect(mail, `verification mail to ${email}`).toBeTruthy();
		const res = await auth.handler(new Request(linkIn(mail!.text), { headers: headers() }));
		expect([200, 302]).toContain(res.status);
	}
	async function signIn(email: string, password = PASSWORD, h = headers()) {
		return auth.api.signInEmail({ body: { email, password }, headers: h });
	}

	it('sign up mails a link, and an unverified account cannot sign in until the link is used', async () => {
		const email = fresh();
		await signUp(email);
		expect(lastMailTo(email)?.subject).toBe('Confirm your email address');
		await expect(signIn(email)).rejects.toMatchObject({ status: 'FORBIDDEN' });
		// Trying to sign in again sends a fresh link
		expect(outbox.filter((m) => m.to === email).length).toBeGreaterThanOrEqual(2);
		await verify(email);
		const ok = await signIn(email);
		expect(ok.user.email).toBe(email);
		expect(ok.user.emailVerified).toBe(true);
	});

	it('refuses a short password', async () => {
		await expect(
			auth.api.signUpEmail({ body: { email: fresh(), password: 'short', name: 'X' } })
		).rejects.toMatchObject({ status: 'BAD_REQUEST' });
	});

	it('a failed send is reported, never hidden, and the account still exists for a retry', async () => {
		const email = 'fail@example.com';
		const r = await registerAccount(auth, { email, password: PASSWORD, name: 'Failing Mail' });
		expect(r).toMatchObject({ ok: false, code: 'EMAIL_FAILED', email });
		expect(r.ok === false && r.message).toContain('We could not send the email');
		expect(outbox.filter((m) => m.to === email)).toHaveLength(0);
		expect(await db.db.select().from(user).where(eq(user.email, email))).toHaveLength(1);
		// The resend button reports the same failure while the mail server still refuses
		expect(await resendVerification(auth, email)).toMatchObject({
			ok: false,
			code: 'EMAIL_FAILED'
		});
		// A second sign up with the same address is told the account exists
		const again = await registerAccount(auth, { email, password: PASSWORD, name: 'Failing Mail' });
		expect(again.ok).toBe(false);
	});

	it('reset password mails a link, sets a new password, and the old one stops working', async () => {
		const email = fresh();
		await signUp(email);
		await verify(email);
		await auth.api.requestPasswordReset({
			body: { email, redirectTo: `${BASE}/reset` },
			headers: headers()
		});
		const mail = lastMailTo(email)!;
		expect(mail.subject).toBe('Reset your password');
		const link = new URL(linkIn(mail.text));
		const token = link.pathname.split('/').pop()!;
		await auth.api.resetPassword({ body: { newPassword: 'another long password', token } });
		await expect(signIn(email, PASSWORD)).rejects.toBeTruthy();
		const ok = await signIn(email, 'another long password');
		expect(ok.user.email).toBe(email);
	});

	it('locks the account after repeated wrong passwords, refuses even the right one, and unlocks later', async () => {
		const email = fresh();
		await signUp(email);
		await verify(email);
		for (let i = 0; i < MAX_FAILURES; i++)
			await expect(signIn(email, 'wrong password!')).rejects.toBeTruthy();
		await expect(signIn(email, PASSWORD)).rejects.toMatchObject({
			body: { code: 'ACCOUNT_LOCKED' }
		});
		// The lock ends: move it into the past
		await db.db
			.update(authLockout)
			.set({ lockedUntil: new Date(Date.now() - 1000) })
			.where(eq(authLockout.email, email));
		const ok = await signIn(email, PASSWORD);
		expect(ok.user.email).toBe(email);
		// A good sign in clears the count
		expect(await db.db.select().from(authLockout).where(eq(authLockout.email, email))).toHaveLength(
			0
		);
	});

	it('lock lengths grow with each round', () => {
		expect(lockMinutes(4)).toBe(0);
		expect(lockMinutes(5)).toBe(5);
		expect(lockMinutes(10)).toBe(10);
		expect(lockMinutes(15)).toBe(20);
		expect(lockMinutes(5000)).toBe(24 * 60);
	});

	it('a new device sends an alert, the first device and a known one do not', async () => {
		const email = fresh();
		await signUp(email);
		await verify(email);
		outbox.length = 0;
		await signIn(
			email,
			PASSWORD,
			headers('Mozilla/5.0 (Windows NT 10.0) Chrome/150.0 Safari/537.36', '203.0.113.9')
		);
		expect(outbox.filter((m) => m.subject === 'New sign in to your account')).toHaveLength(0);
		await signIn(
			email,
			PASSWORD,
			headers('Mozilla/5.0 (Windows NT 10.0) Chrome/150.0 Safari/537.36', '203.0.113.77')
		);
		expect(outbox.filter((m) => m.subject === 'New sign in to your account')).toHaveLength(0);
		await signIn(
			email,
			PASSWORD,
			headers('Mozilla/5.0 (Macintosh; Intel Mac OS X) Firefox/140.0', '198.51.100.4')
		);
		const alerts = outbox.filter((m) => m.subject === 'New sign in to your account');
		expect(alerts).toHaveLength(1);
		expect(alerts[0].text).toContain('Firefox on macOS');
		expect(alerts[0].text).not.toContain('198.51.100.4');
	});

	it('discards an unverified duplicate when the owner signs in with Google, and never touches a verified account', async () => {
		const squatted = fresh();
		await signUp(squatted, 'Squatter');
		expect(await db.db.select().from(user).where(eq(user.email, squatted))).toHaveLength(1);
		expect(await purgeUnverifiedDuplicate(db.db, squatted)).toBe(true);
		expect(await db.db.select().from(user).where(eq(user.email, squatted))).toHaveLength(0);
		expect(
			await db.db.select().from(authAccount).where(eq(authAccount.accountId, squatted))
		).toHaveLength(0);
		const real = fresh();
		await signUp(real);
		await verify(real);
		expect(await purgeUnverifiedDuplicate(db.db, real)).toBe(false);
		expect(await db.db.select().from(user).where(eq(user.email, real))).toHaveLength(1);
	});
});

describe('request limits', () => {
	it('sign in attempts from one address are limited per minute', async () => {
		const handle = await makePglite();
		try {
			const limited = createAuth({
				handle,
				mailer: createMailer({ provider: 'log', from: 'b@example.com' }),
				config: { secret: 'q'.repeat(40), baseUrl: BASE, checkBreachedPasswords: false }
			});
			let refused = 0;
			for (let i = 0; i < 14; i++) {
				const res = await limited.handler(
					new Request(`${BASE}/api/auth/sign-in/email`, {
						method: 'POST',
						headers: {
							'content-type': 'application/json',
							origin: BASE,
							'x-forwarded-for': '198.51.100.20'
						},
						body: JSON.stringify({
							email: `nobody${i}@example.com`,
							password: 'does not matter at all'
						})
					})
				);
				if (res.status === 429) refused++;
			}
			expect(refused).toBeGreaterThanOrEqual(3);
		} finally {
			await handle.stop();
		}
	});
});

describe('breached password check', () => {
	it('refuses a password found in the corpus and sends only the 5 character hash prefix', async () => {
		const handle = await makePglite();
		const calls: string[] = [];
		const real = globalThis.fetch;
		vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('pwnedpasswords.com')) {
				calls.push(url);
				// The service answers with every suffix that shares the prefix, here the one for the password under test
				const suffix = createHash('sha1')
					.update('password123')
					.digest('hex')
					.toUpperCase()
					.slice(5);
				return new Response(`${suffix}:99999\n`, { status: 200 });
			}
			return real(input);
		});
		try {
			const auth = createAuth({
				handle,
				mailer: createMailer({ provider: 'log', from: 'b@example.com' }),
				config: {
					secret: 'y'.repeat(40),
					baseUrl: BASE,
					checkBreachedPasswords: true,
					disableRateLimit: true
				}
			});
			await expect(
				auth.api.signUpEmail({
					body: { email: 'pw@example.com', password: 'password123', name: 'P' }
				})
			).rejects.toBeTruthy();
			expect(calls).toHaveLength(1);
			expect(new URL(calls[0]).pathname.split('/').pop()).toHaveLength(5);
		} finally {
			vi.unstubAllGlobals();
			await handle.stop();
		}
	});
});
