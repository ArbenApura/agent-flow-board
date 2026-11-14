// SERVES ONE MOCKUP FILE FOR A SIGNED 5 MINUTE LINK. THE ISOLATING HEADERS COME FROM serveMemberMockup ON EVERY ANSWER, ERRORS INCLUDED

// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- ENVS -- //
import { BETTER_AUTH_SECRET } from '$app/env/private';
// -- MODULES -- //
import { getStorage } from '#lib/server/adapters/index.js';
import { getDb } from '#lib/server/db/index.js';
import { serveMemberMockup } from '#lib/server/mockups/serve.js';

// -- FUNCTIONS -- //

export const GET: RequestHandler = async ({ params, url }) =>
	serveMemberMockup(
		{ handle: await getDb(), storage: getStorage() },
		BETTER_AUTH_SECRET,
		params,
		{
			exp: url.searchParams.get('exp'),
			sig: url.searchParams.get('sig')
		},
		Date.now(),
		url.origin
	);
