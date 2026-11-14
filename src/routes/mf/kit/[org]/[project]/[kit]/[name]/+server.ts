// SERVES ONE SIGNED KIT ASSET FILE (CSS, FONT OR IMAGE) WITH ISOLATING HEADERS AND CORS FOR SANDBOXED MOCKUPS

// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED ENVS
import { BETTER_AUTH_SECRET } from '$app/env/private';
// IMPORTED MODULES
import { getStorage } from '#lib/server/adapters/index.js';
import { getDb } from '#lib/server/db/index.js';
import { serveMemberKitAsset } from '#lib/server/mockups/serve.js';

// -- FUNCTIONS -- //

export const GET: RequestHandler = async ({ params, url }) =>
	serveMemberKitAsset(
		{ handle: await getDb(), storage: getStorage() },
		BETTER_AUTH_SECRET,
		params,
		{
			exp: url.searchParams.get('exp'),
			sig: url.searchParams.get('sig')
		}
	);
