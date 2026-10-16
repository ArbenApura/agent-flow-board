// THE APP'S GITHUB CLIENT, BUILT ONCE FROM THE ENVIRONMENT. PUBLISHING IS OFF UNTIL THE APP ID AND PRIVATE KEY ARE SET.

// -- TYPES -- //
import type { GithubApi, GithubConfig } from './app';
// -- ENVS -- //
import {
	GITHUB_API_URL,
	GITHUB_APP_ID,
	GITHUB_APP_PRIVATE_KEY,
	GITHUB_APP_SLUG,
	GITHUB_WEBHOOK_SECRET,
	GITHUB_WEB_URL
} from '$app/env/private';
// -- MODULES -- //
import { createGithubApi } from './app';

// -- STATES -- //

let api: GithubApi | null | undefined;

// -- FUNCTIONS -- //

/** The settings, or null when the App is not set up. A half set up App stops the app at the first use, not silently. */
export function githubConfig(): (GithubConfig & { webUrl: string }) | null {
	if (!GITHUB_APP_ID && !GITHUB_APP_PRIVATE_KEY) return null;
	if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY)
		throw new Error('GitHub publishing needs both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY');
	return {
		apiUrl: GITHUB_API_URL,
		webUrl: GITHUB_WEB_URL,
		appId: GITHUB_APP_ID,
		privateKey: GITHUB_APP_PRIVATE_KEY,
		webhookSecret: GITHUB_WEBHOOK_SECRET,
		appSlug: GITHUB_APP_SLUG
	};
}

export function getGithub(): GithubApi | null {
	if (api !== undefined) return api;
	const config = githubConfig();
	api = config ? createGithubApi(config) : null;
	return api;
}
