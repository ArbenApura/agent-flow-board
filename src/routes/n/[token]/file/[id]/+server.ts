// SERVES ONE PICTURE OF THE NOTE A PUBLIC ADDRESS NAMES. NO SESSION IS READ, AND EVERY KIND OF FAILURE ANSWERS THE SAME 404

// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- MODULES -- //
import { getStorage } from '#lib/server/adapters/index.js';
import { getDb } from '#lib/server/db/index.js';
import { publicRateAllowed } from '#lib/server/mockups/limit.js';
import { servePublicNoteFile } from '#lib/server/web/notePublic.js';

// -- FUNCTIONS -- //

export const GET: RequestHandler = async ({ params, getClientAddress }) => {
	let address = '';
	try {
		address = getClientAddress();
	} catch {
		/* No address behind some adapters, so all of them share one bucket */
	}
	// The limit is checked before anything else, and a wrong address costs the same as a right one
	if (!publicRateAllowed(address))
		return new Response('Too many requests', {
			status: 429,
			headers: {
				'content-type': 'text/plain; charset=utf-8',
				'retry-after': '60',
				'referrer-policy': 'no-referrer'
			}
		});
	return servePublicNoteFile(
		{ handle: await getDb(), storage: getStorage() },
		params.token,
		params.id
	);
};
