// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
// IMPORTED MODULES
import { renderMarkdown } from '#lib/markdown.js';
import { getDb } from '#lib/server/db/index.js';
import { publicRateAllowed } from '#lib/server/mockups/limit.js';
import { findPublicNote } from '#lib/server/web/notePublic.js';
import { PUBLIC_LINK_BASE, publicNoteHtml } from '#lib/shared/notePublic.js';

// -- FUNCTIONS -- //

/**
 * The public page of a note link. No session is read. A wrong address, a link that is off, a note in the trash and a private
 * note all give the same answer, so nothing says which one it was. The address is never logged and never sent back.
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
	const found = await findPublicNote(await getDb(), params.token);
	if (!found) return { available: false as const };
	return {
		available: true as const,
		title: found.title,
		sharedBy: found.sharedBy,
		projectName: found.projectName,
		updatedAt: found.updatedAt.toISOString(),
		empty: found.body.trim() === '',
		// Anyone on the project may have written the text, so it is always rendered as untrusted
		html: publicNoteHtml(
			renderMarkdown(found.body, { untrusted: true, mode: 'note', linkBase: PUBLIC_LINK_BASE }),
			params.token
		)
	};
};
