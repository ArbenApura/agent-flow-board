// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- ENVS -- //
import { BETTER_AUTH_SECRET } from '$app/env/private';
// -- DEP-MODULES -- //
import { error } from '@sveltejs/kit';
// -- MODULES -- //
import { githubConfig } from '#lib/server/github/index.js';
import { installUrl, signState } from '#lib/server/github/install.js';
import { publishState } from '#lib/server/github/publish.js';
import { getProject } from '#lib/server/ops/projects.js';
import { orgContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** Starts the install of the GitHub App for one project, for a person who may publish it. */
export const GET: RequestHandler = async ({ url, locals }) => {
	const org = url.searchParams.get('org') ?? '';
	const key = url.searchParams.get('project') ?? '';
	const { ctx, user } = await orgContext(locals, org, url.pathname + url.search);
	const config = githubConfig();
	if (!config?.appSlug) error(404, 'GitHub publishing is not set up on this server.');
	const state = await publishState(ctx, key).catch(() => null);
	if (!state?.canPublish) error(403, 'Only an admin or owner can connect a repository.');
	const project = await getProject(ctx, key);
	const signed = await signState(BETTER_AUTH_SECRET, {
		orgId: ctx.orgId,
		projectId: project.id,
		userId: user.id
	});
	return new Response(null, {
		status: 303,
		headers: { location: installUrl(config.webUrl, config.appSlug, signed) }
	});
};
