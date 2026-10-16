// M2: sign up with password, email verification, sign in, password reset, a visible error when email sending fails,
// and lockout after repeated failures. (The unverified duplicate replaced on Google sign in is proved against the real
// Better Auth instance in tests/auth/auth.test.ts, since no browser can reach Google here.)
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';

const OUTBOX = '.afb/outbox.jsonl';
const PASSWORD = 'a long enough password';
const tag = Date.now().toString(36);
let n = 0;
const fresh = (prefix = 'qa') => `${prefix}-${tag}-${++n}@example.com`;

type Mail = { to: string; subject: string; text: string };
function mailsTo(email: string): Mail[] {
	if (!existsSync(OUTBOX)) return [];
	return readFileSync(OUTBOX, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Mail)
		.filter((m) => m.to === email);
}
const linkOf = (m: Mail) => /(https?:\/\/\S+)/.exec(m.text)![1];

async function signUp(page: Page, email: string, name = 'QA Person') {
	await page.goto('/sign-up');
	await page.getByLabel('Your name').fill(name);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Create account' }).click();
}

async function signIn(page: Page, email: string, password = PASSWORD) {
	await page.goto('/sign-in');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Signs up and follows the emailed link, leaving the person signed in on the home page. */
async function verified(page: Page, email: string) {
	await signUp(page, email);
	await expect(page).toHaveURL(/\/verify/);
	await page.goto(linkOf(mailsTo(email)[0]));
	await expect(page.getByRole('heading', { name: 'Your organisations' })).toBeVisible();
}

test('sign up, verify by email, land signed in, sign out and sign in again', async ({ page }) => {
	const email = fresh();
	await signUp(page, email);
	await expect(page).toHaveURL(/\/verify/);
	await expect(page.getByTestId('email-sent')).toContainText(email);
	const mails = mailsTo(email);
	expect(mails).toHaveLength(1);
	expect(mails[0].subject).toBe('Confirm your email address');
	// Before the link is used, signing in is refused and offers a new link
	await signIn(page, email);
	await expect(page.getByTestId('auth-error')).toContainText('Confirm your email address first');
	await page.getByRole('button', { name: 'Send a new confirmation link' }).click();
	await expect(page).toHaveURL(/\/verify/);
	expect(mailsTo(email).length).toBeGreaterThanOrEqual(2);
	// The link verifies and signs the person in
	await page.goto(linkOf(mailsTo(email).at(-1)!));
	await expect(page.getByRole('heading', { name: 'Your organisations' })).toBeVisible();
	await expect(page.getByTestId('signed-in-as')).toContainText(email);
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/sign-in/);
	await signIn(page, email);
	await expect(page.getByRole('heading', { name: 'Your organisations' })).toBeVisible();
});

test('a wrong password gives one plain message that does not reveal whether the account exists', async ({
	page
}) => {
	await signIn(page, fresh('nobody'), 'whatever password');
	const unknown = await page.getByTestId('auth-error').innerText();
	const email = fresh();
	await verified(page, email);
	await page.getByRole('button', { name: 'Sign out' }).click();
	await signIn(page, email, 'the wrong password!');
	const wrong = await page.getByTestId('auth-error').innerText();
	expect(wrong).toBe(unknown);
	expect(wrong).toContain('email or the password is not right');
});

test('password reset: link by email, new password, old one stops working, link works once', async ({
	page
}) => {
	const email = fresh();
	await verified(page, email);
	await page.getByRole('button', { name: 'Sign out' }).click();
	await page.goto('/reset');
	await page.getByLabel('Email').fill(email);
	await page.getByRole('button', { name: 'Send the link' }).click();
	await expect(page.getByTestId('reset-sent')).toBeVisible();
	const mail = mailsTo(email).find((m) => m.subject === 'Reset your password')!;
	expect(mail).toBeTruthy();
	const link = linkOf(mail);
	await page.goto(link);
	await expect(page).toHaveURL(/\/reset\/new\?token=/);
	await page.getByLabel('New password').fill('another long password');
	await page.getByRole('button', { name: 'Save password' }).click();
	await expect(page).toHaveURL(/\/sign-in\?reset=1/);
	await expect(page.getByRole('status')).toContainText('Your password was changed');
	await signIn(page, email, PASSWORD);
	await expect(page.getByTestId('auth-error')).toBeVisible();
	await signIn(page, email, 'another long password');
	await expect(page.getByRole('heading', { name: 'Your organisations' })).toBeVisible();
	await page.getByRole('button', { name: 'Sign out' }).click();
	// The same link cannot be used again
	await page.goto(link);
	await expect(page.getByTestId('reset-invalid')).toBeVisible();
});

test('a reset request answers the same for an unknown address', async ({ page }) => {
	await page.goto('/reset');
	await page.getByLabel('Email').fill(fresh('ghost'));
	await page.getByRole('button', { name: 'Send the link' }).click();
	await expect(page.getByTestId('reset-sent')).toContainText('If an account uses');
});

test('a failed verification email is shown with a resend button, never hidden', async ({
	page
}) => {
	const email = fresh('mailfail');
	await signUp(page, email);
	await expect(page).toHaveURL(/\/verify.*failed=1/);
	await expect(page.getByTestId('email-failed')).toContainText('could not send');
	expect(mailsTo(email)).toHaveLength(0);
	await page.getByRole('button', { name: 'Send the link again' }).click();
	await expect(page.getByTestId('email-failed')).toContainText('We could not send the email');
	expect(mailsTo(email)).toHaveLength(0);
});

test('five wrong passwords lock the account, and even the right password is refused', async ({
	page
}) => {
	const email = fresh();
	await verified(page, email);
	await page.getByRole('button', { name: 'Sign out' }).click();
	for (let i = 0; i < 5; i++) await signIn(page, email, `wrong password ${i}`);
	await signIn(page, email, PASSWORD);
	await expect(page.getByTestId('auth-error')).toContainText('Too many failed attempts');
	await expect(page).toHaveURL(/\/sign-in/);
});

test('the server refuses a password that is too short even when the browser check is skipped', async ({
	page
}) => {
	const email = fresh();
	const res = await page.request.post('/sign-up?/register', {
		form: { name: 'Short Pass', email, password: 'short', next: '/' },
		headers: { origin: 'http://localhost:5180' }
	});
	expect(res.status()).toBeLessThan(500);
	expect(await res.text()).toContain('at least 10 characters');
	expect(mailsTo(email)).toHaveLength(0);
});

test('signed in people skip sign in, and a next link cannot send anyone to another site', async ({
	page
}) => {
	const email = fresh();
	await verified(page, email);
	await page.goto('/sign-in');
	await expect(page).toHaveURL(/localhost:\d+\/$/);
	await page.getByRole('button', { name: 'Sign out' }).click();
	await page.goto('/sign-in?next=' + encodeURIComponent('https://evil.example/steal'));
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/localhost:\d+\/$/);
});

test('an invalid invitation link says so', async ({ page }) => {
	await page.goto('/invite/not-a-real-token');
	await expect(page.getByTestId('invite-invalid')).toBeVisible();
});

test('a form post from another site, or with no origin, is refused, while token endpoints take tools with no origin', async ({
	request
}) => {
	const form = { email: 'nobody@example.com', password: 'does not matter at all' };
	expect(
		(
			await request.post('/sign-in?/signIn', { form, headers: { origin: 'https://evil.example' } })
		).status()
	).toBe(403);
	expect((await request.post('/sign-in?/signIn', { form })).status()).toBe(403);
	expect(
		(
			await request.post('/sign-in?/signIn', { form, headers: { origin: 'http://localhost:5180' } })
		).status()
	).toBeLessThan(500);
	// Tools call these with no Origin header and authenticate with tokens, so they are exempt
	const token = await request.post('/oauth/token', {
		form: { grant_type: 'refresh_token', refresh_token: 'afr_x', client_id: 'x' }
	});
	expect(token.status()).toBe(400);
	expect((await token.json()).error).toBe('invalid_grant');
});
