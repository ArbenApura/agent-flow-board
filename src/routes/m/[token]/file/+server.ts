// SERVES THE MOCKUP OF A PUBLIC LINK, SANDBOXED. NO SESSION IS READ, AND EVERY KIND OF FAILURE ANSWERS THE SAME PLAIN PAGE

// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- MODULES -- //
import { getStorage } from '#lib/server/adapters/index.js';
import { getDb } from '#lib/server/db/index.js';
import { publicRateAllowed } from '#lib/server/mockups/limit.js';
import { mockupResponse, servePublicMockup } from '#lib/server/mockups/serve.js';

// -- FUNCTIONS -- //

export const GET: RequestHandler = async ({ params, url, getClientAddress }) => {
	let address = '';
	try {
		address = getClientAddress();
	} catch {
		/* No address behind some adapters, so all of them share one bucket */
	}
	// The limit is checked before anything else, and a wrong address costs the same as a right one
	if (!publicRateAllowed(address))
		return mockupResponse({
			status: 429,
			body: 'Too many requests',
			type: 'text/plain; charset=utf-8',
			extra: { 'retry-after': '60', 'referrer-policy': 'no-referrer' }
		});
	// A public address always shows the current version, never an older one the author replaced
	return servePublicMockup(
		{ handle: await getDb(), storage: getStorage() },
		params.token,
		undefined,
		url.searchParams.get('shot') === '1',
		url.origin
	);
};
