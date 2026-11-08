// SIGNING IN TO THE PREVIEW AS ITS TEST USER
// The recipe may name a preview-only account (a user the app seeds in the throwaway database). The tool types its email and password into the
// app's own sign in form in a browser that records nothing, keeps only the cookies and storage it ends with, and forgets the password. The
// password is only ever typed into the app under test: the sign in page must be on its own address, and nothing else is reachable.

// -- MODULES -- //
import { loadPlaywright } from './browser.js';
import { redact } from './redact.js';

// -- TYPES -- //

type SignInPage = { path: string; emailLabel: string; passwordLabel: string; submit: string };

// -- CONSTANTS -- //

const DEFAULT_PAGE: SignInPage = {
	path: '/sign-in',
	emailLabel: 'Email',
	passwordLabel: 'Password',
	submit: 'Sign in'
};

// -- FUNCTIONS -- //

/** The browser flag that makes every host except this machine and the site's own unresolvable. */
export const hostResolverRules = (siteHost: string): string => {
	const hosts = [...new Set(['127.0.0.1', 'localhost', siteHost.toLowerCase()])];
	return `--host-resolver-rules=MAP * ~NOTFOUND, ${hosts.map((h) => `EXCLUDE ${h}`).join(', ')}`;
};

const mask = (email: string) => email.replace(/^(.).*(@.*)$/, '$1***$2');

/** Signs in through the app's own form and returns the browser state. The error never holds the password. */
export async function signInWithPassword(
	baseUrl: string,
	account: { email: string; password: string },
	page: Partial<SignInPage> = {}
): Promise<unknown> {
	const s = { ...DEFAULT_PAGE, ...page };
	const origin = new URL(baseUrl).origin;
	if (new URL(s.path, baseUrl).origin !== origin)
		throw new Error(`The sign in page ${s.path} is not on ${origin}, so nothing was typed.`);
	const { chromium } = await loadPlaywright();
	const browser = await chromium.launch({
		headless: true,
		// The site's own host is reachable too (a live site is not on this machine); every other host is unresolvable
		args: [hostResolverRules(new URL(baseUrl).hostname)]
	});
	try {
		const ctx = await browser.newContext({ baseURL: baseUrl, serviceWorkers: 'block' });
		await ctx.route('**/*', (route) =>
			new URL(route.request().url()).origin === origin || route.request().url().startsWith('data:')
				? route.continue()
				: route.abort()
		);
		const tab = await ctx.newPage();
		await tab.goto(s.path, { waitUntil: 'load', timeout: 30_000 });
		await tab.getByLabel(s.emailLabel, { exact: true }).fill(account.email);
		await tab.getByLabel(s.passwordLabel, { exact: true }).fill(account.password);
		await tab.getByRole('button', { name: s.submit, exact: true }).click();
		try {
			await tab.waitForURL((u) => u.pathname !== new URL(s.path, baseUrl).pathname, {
				timeout: 20_000
			});
		} catch {
			const shown = (
				await tab
					.locator('[role=alert]')
					.first()
					.textContent({ timeout: 1000 })
					.catch(() => null)
			)?.trim();
			throw new Error(
				redact(
					`Signing in as ${mask(account.email)} did not leave ${s.path}${shown ? `. The page says: ${shown.slice(0, 200)}` : ''}. An account that only signs in with Google has no password: use a recipe test user, which has one.`,
					[account.password]
				)
			);
		}
		return await ctx.storageState();
	} finally {
		await browser.close().catch(() => undefined);
	}
}

/** Every secret value in a saved browser state (cookie values and stored values), so a run never prints or uploads them. */
export function stateNeedles(state: unknown): string[] {
	const out = new Set<string>();
	const add = (v: unknown) => {
		if (typeof v === 'string' && v.length >= 8) {
			out.add(v);
			out.add(encodeURIComponent(v));
		}
	};
	const s = state as {
		cookies?: { value?: unknown }[];
		origins?: { localStorage?: { value?: unknown }[] }[];
	} | null;
	for (const c of s?.cookies ?? []) add(c.value);
	for (const o of s?.origins ?? []) for (const l of o.localStorage ?? []) add(l.value);
	return [...out];
}
