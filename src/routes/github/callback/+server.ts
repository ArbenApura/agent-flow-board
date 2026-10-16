// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- ENVS -- //
import { BETTER_AUTH_SECRET } from '$app/env/private';
// -- DEP-MODULES -- //
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import { getGithub } from '#lib/server/github/index.js';
import { githubInstallation, org, project } from '#lib/server/db/schema/index.js';
import { withTenant } from '#lib/server/db/tenant.js';
import { verifyState } from '#lib/server/github/install.js';
import { requireUser } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/**
 * Where GitHub sends the person after installing the App. The signed state says who started it and for which project, and
 * the installation is remembered for that org only. It then opens the project's publish page to pick the repository.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	const user = requireUser(locals, url.pathname + url.search);
	const state = await verifyState(BETTER_AUTH_SECRET, url.searchParams.get('state') ?? '');
	if (!state || state.userId !== user.id)
		error(400, 'This install link is not valid or has expired. Start again from the project.');
	const installationId = url.searchParams.get('installation_id') ?? '';
	if (!/^[0-9]{1,20}$/.test(installationId)) error(400, 'GitHub did not send an installation.');
	const handle = await getDb();
	const github = getGithub();
	const target = await withTenant(
		handle,
		{ orgId: state.orgId, projectId: state.projectId, userId: user.id },
		async (tx) => {
			const [o] = await tx.select({ slug: org.slug }).from(org).where(eq(org.id, state.orgId));
			const [p] = await tx
				.select({ key: project.key })
				.from(project)
				.where(eq(project.id, state.projectId));
			if (!o || !p) return null;
			// An installation belongs to one org. Another org that already holds it keeps it.
			const [held] = await tx
				.select()
				.from(githubInstallation)
				.where(eq(githubInstallation.installationId, installationId));
			if (held && held.orgId !== state.orgId) return 'taken' as const;
			if (!held) {
				// GitHub does not sign this redirect, so the id in it proves nothing by itself. A first time installation must have
				// been made by this very flow, or anyone could claim another organisation's installation by editing the address.
				const made = await github?.installationCreatedAt(installationId);
				if (!made || made.getTime() < state.startedAt - 120_000) return 'old' as const;
				await tx.insert(githubInstallation).values({ installationId, orgId: state.orgId });
			}
			return { slug: o.slug, key: p.key };
		}
	);
	if (!target) error(404, 'Not found');
	if (target === 'taken')
		error(409, 'This GitHub installation is already connected to another organisation.');
	if (target === 'old')
		error(
			403,
			'This installation was not made from this install link. Remove the App from the GitHub account and install it again from the project.'
		);
	return new Response(null, {
		status: 303,
		headers: { location: `/${target.slug}/${target.key}/publish?installation=${installationId}` }
	});
};
