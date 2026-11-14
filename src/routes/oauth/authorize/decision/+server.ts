// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED ENVS
import { AFB_BASE_URL } from '$app/env/private';
// IMPORTED DEP-MODULES
import { redirect } from '@sveltejs/kit';
// IMPORTED MODULES
import { getDb } from '#lib/server/db/index.js';
import { callbackUrl, checkAuthorize } from '#lib/server/oauth/authorize.js';
import { isOAuthError, issueCode } from '#lib/server/oauth/oauth.js';
import { canonicalResource, orgSlugFromResource } from '#lib/server/oauth/resource.js';
import { listMyOrgs } from '#lib/server/orgs/orgs.js';

// -- CONSTANTS -- //

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

// -- FUNCTIONS -- //

/** A redirect to the tool's own address. SvelteKit's redirect() refuses outside addresses, so this answers 303 directly. */
const external = (location: string) =>
	new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });

/** The person's answer on the consent page. Everything is checked again from the original request, never trusted from the form's other fields. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const data = await request.formData();
	const raw = new URLSearchParams(
		PARAMS.flatMap((k) =>
			data.get(k) !== null ? [[k, String(data.get(k))] as [string, string]] : []
		)
	);
	if (!locals.user) redirect(303, `/sign-in?next=${encodeURIComponent('/oauth/authorize?' + raw)}`);
	const back = (message: string) =>
		redirect(303, `/oauth/authorize?${raw}&notice=${encodeURIComponent(message)}`);
	const handle = await getDb();
	const checked = await checkAuthorize(handle, raw);
	if (!checked.ok) return back(checked.problem);
	if (data.get('decision') === 'deny')
		return external(
			callbackUrl(checked.request.redirectUri, {
				error: 'access_denied',
				state: checked.request.state
			})
		);
	// A tool started from /mcp/<slug> may only be approved for that org, whatever the form says. Any other resource leaves the choice as before
	const slug = orgSlugFromResource(raw.get('resource'), AFB_BASE_URL);
	let orgId = String(data.get('org') ?? '');
	if (slug) {
		const mine = (await listMyOrgs(handle, locals.user.id)).find(
			(o) => o.slug === slug && !o.deletedAt
		);
		if (!mine)
			return back(
				'The address this tool was given belongs to an organisation you are not in, or one that does not exist.'
			);
		orgId = mine.id;
	}
	if (!orgId) return back('Choose which organisation to connect.');
	const code = await issueCode(handle, {
		resource: slug ? canonicalResource(AFB_BASE_URL, slug) : null,
		orgId,
		userId: locals.user.id,
		clientId: checked.request.clientId,
		redirectUri: checked.request.redirectUri,
		challenge: checked.request.challenge,
		scopes: data.getAll('scope').map(String) as never
	});
	if (isOAuthError(code)) return back(code.error_description);
	return external(callbackUrl(checked.request.redirectUri, { code, state: checked.request.state }));
};
