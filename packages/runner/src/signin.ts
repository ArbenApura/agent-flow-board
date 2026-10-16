// THE BUILT-IN SIGN-IN STEP: THE RUNNER SIGNS IN, THE SCRIPT NEVER SEES THE PASSWORD (SPEC 10, L2)
// Signing in happens in its own browser context that records nothing: no trace, no video, no screenshots. Only the cookies and
// storage it ends with are handed to the context the script runs in, so the password is never typed in front of a recorder.

// -- TYPES -- //
import type { Browser } from '@playwright/test';
import type { Account } from './api';
import type { RunnerConfig } from './config';

export type StorageState = Awaited<
	ReturnType<import('@playwright/test').BrowserContext['storageState']>
>;

/** Signing in did not work. The message never holds the password. */
export class SignInFailed extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SignInFailed';
	}
}

// -- FUNCTIONS -- //

/** Signs in with one test account and returns the browser state to run with. */
export async function signIn(
	browser: Browser,
	baseUrl: string,
	account: Account,
	cfg: RunnerConfig['signIn']
): Promise<StorageState> {
	const ctx = await browser.newContext({ baseURL: baseUrl });
	try {
		const page = await ctx.newPage();
		await page.goto(cfg.path, { waitUntil: 'load', timeout: 30_000 });
		await page.getByLabel(cfg.emailLabel, { exact: true }).fill(account.email);
		await page.getByLabel(cfg.passwordLabel, { exact: true }).fill(account.password);
		await page.getByRole('button', { name: cfg.submit, exact: true }).click();
		try {
			await page.waitForURL((u) => u.pathname !== cfg.successNotPath, { timeout: 20_000 });
		} catch {
			const shown = (
				await page
					.locator('[role=alert]')
					.first()
					.textContent({ timeout: 1000 })
					.catch(() => null)
			)?.trim();
			throw new SignInFailed(
				`Signing in as ${account.email} did not leave ${cfg.successNotPath}${shown ? `. The page says: ${shown.slice(0, 200)}` : ''}`
			);
		}
		return await ctx.storageState();
	} finally {
		await ctx.close();
	}
}
