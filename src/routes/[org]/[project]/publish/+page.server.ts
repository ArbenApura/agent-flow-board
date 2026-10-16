// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- ENVS -- //
import { GITHUB_APP_SLUG, GITHUB_WEB_URL } from '$app/env/private';
// -- MODULES -- //
import { GithubError } from '#lib/server/github/app.js';
import { ownsInstallation, previewPublish, publishState } from '#lib/server/github/publish.js';
import { childContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** The publish page: the connection, what a publish would change, the waiting publish and the history. */
export const load: PageServerLoad = async ({ params, parent, locals, url, depends }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	const webUrl = GITHUB_WEB_URL;
	if (!summary)
		return { state: null, preview: null, repos: [], repoError: '', webUrl, canInstall: false };
	const ctx = await childContext(locals, org.id);
	const state = await publishState(ctx, params.project);
	const preview = state.link && state.canPublish ? await previewPublish(ctx, params.project) : null;
	// After the install, GitHub sends the person back with the installation id, and the repositories it can reach are offered
	const installation = url.searchParams.get('installation');
	let repos: { fullName: string; private: boolean; defaultBranch: string }[] = [];
	let repoError = '';
	if (
		installation &&
		/^[0-9]{1,20}$/.test(installation) &&
		state.canPublish &&
		ctx.services?.github &&
		(await ownsInstallation(ctx, installation))
	) {
		try {
			repos = await ctx.services.github.listInstallationRepos(installation);
		} catch (e) {
			repoError = e instanceof GithubError ? e.message : 'GitHub could not list the repositories.';
		}
	}
	return {
		state,
		preview,
		repos,
		repoError,
		webUrl,
		canInstall: Boolean(GITHUB_APP_SLUG),
		installation: installation && /^[0-9]{1,20}$/.test(installation) ? installation : null
	};
};
