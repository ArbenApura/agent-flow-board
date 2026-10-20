// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- ENVS -- //
import { AFB_BASE_URL } from '$app/env/private';
// -- DEP-MODULES -- //
import { redirect } from '@sveltejs/kit';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import { checkAuthorize } from '#lib/server/oauth/authorize.js';
import { grantableCaps } from '#lib/server/oauth/oauth.js';
import { orgSlugFromResource } from '#lib/server/oauth/resource.js';
import { listMyOrgs } from '#lib/server/orgs/orgs.js';

// -- CONSTANTS -- //

/** The request parameters carried through the consent form as hidden fields, then checked again by the decision endpoint. */
const PARAMS = [
	'response_type',
	'client_id',
	'redirect_uri',
	'code_challenge',
	'code_challenge_method',
	'state',
	'scope',
	'resource'
];
const pick = (source: URLSearchParams) =>
	new URLSearchParams(
		PARAMS.flatMap((k) =>
			source.get(k) !== null ? [[k, String(source.get(k))] as [string, string]] : []
		)
	);

// -- FUNCTIONS -- //

export const load: PageServerLoad = async ({ url, locals }) => {
	const handle = await getDb();
	const checked = await checkAuthorize(handle, url.searchParams);
	if (!checked.ok)
		return {
			problem: checked.problem,
			request: null,
			orgs: [],
			locked: false,
			raw: {} as Record<string, string>,
			notice: null as string | null
		};
	// Signing in comes first, then the person comes straight back to this exact request
	if (!locals.user) redirect(303, `/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`);
	// An org scheduled for deletion cannot be connected to
	let orgs = (await listMyOrgs(handle, locals.user.id)).filter((o) => !o.deletedAt);
	// A tool started from /mcp/<slug> may only be approved for that org: the dropdown is gone and nothing else is offered
	const slug = orgSlugFromResource(url.searchParams.get('resource'), AFB_BASE_URL);
	if (slug) {
		orgs = orgs.filter((o) => o.slug === slug);
		// A non member, an unknown slug and a deleted org read the same
		if (orgs.length === 0)
			return {
				problem:
					'The address this tool was given belongs to an organisation you are not in, or one that does not exist. Open Connect a tool, pick your organisation and copy its connection again.',
				request: null,
				orgs: [],
				locked: false,
				raw: {} as Record<string, string>,
				notice: null as string | null
			};
	}
	const withCaps = await Promise.all(
		orgs.map(async (o) => ({ ...o, caps: await grantableCaps(handle, o.id, locals.user!.id) }))
	);
	return {
		problem: null,
		request: checked.request,
		orgs: withCaps,
		locked: !!slug,
		raw: Object.fromEntries(pick(url.searchParams)),
		notice: url.searchParams.get('notice')
	};
};
