// SERVES ONE EXTRACTED KIT ASSET FILE FOR A PUBLIC MOCKUP LINK WITH ISOLATING HEADERS

// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED MODULES
import { getStorage } from '#lib/server/adapters/index.js';
import { getDb } from '#lib/server/db/index.js';
import { publicRateAllowed } from '#lib/server/mockups/limit.js';
import { mockupResponse, servePublicKitAsset } from '#lib/server/mockups/serve.js';

// -- FUNCTIONS -- //

export const GET: RequestHandler = async ({ params, getClientAddress }) => {
	let address = '';
	try {
		address = getClientAddress();
	} catch {
		/* Behind some adapters every request shares one bucket */
	}
	if (!publicRateAllowed(address))
		return mockupResponse({
			status: 429,
			body: 'Too many requests',
			type: 'text/plain; charset=utf-8',
			extra: { 'retry-after': '60', 'referrer-policy': 'no-referrer' }
		});
	return servePublicKitAsset(
		{ handle: await getDb(), storage: getStorage() },
		params.token,
		params.name
	);
};
