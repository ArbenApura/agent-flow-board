// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import { publicRateAllowed } from '#lib/server/mockups/limit.js';
import { findPublicMockup } from '#lib/server/mockups/serve.js';

// -- FUNCTIONS -- //

/**
 * The public page of a mockup link. No session is read. A wrong address, a link that is off, a trashed mockup and a private
 * plan all give the same answer, so nothing says which one it was. The address is never logged and never sent back.
 */
export const load: PageServerLoad = async ({ params, getClientAddress, setHeaders }) => {
	setHeaders({
		'referrer-policy': 'no-referrer',
		'x-robots-tag': 'noindex',
		'cache-control': 'no-store'
	});
	let address = '';
	try {
		address = getClientAddress();
	} catch {
		/* No address behind some adapters, so all of them share one bucket */
	}
	if (!publicRateAllowed(address)) return { available: false as const };
	const found = await findPublicMockup(await getDb(), params.token);
	if (!found) return { available: false as const };
	return {
		available: true as const,
		title: found.title,
		sharedBy: found.sharedBy,
		projectName: found.projectName,
		planRef: found.planRef,
		version: found.version,
		screens: found.screens
	};
};
