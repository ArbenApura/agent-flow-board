// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED MODULES
import { getStorage } from '#lib/server/adapters/index.js';
import { getDb } from '#lib/server/db/index.js';
import { serveNoteFile } from '#lib/server/web/noteFile.js';

// -- FUNCTIONS -- //

/**
 * One picture of a note (the afb:file/<id> of its text). It needs the signed in person's cookie and checks them against the
 * picture's own note; a refusal of any kind is the same 404.
 */
export const GET: RequestHandler = async ({ params, locals, request }) =>
	serveNoteFile(
		{ handle: await getDb(), storage: getStorage() },
		locals.user ? { id: locals.user.id, name: locals.user.name } : null,
		params.org,
		params.id,
		request.headers.get('if-none-match')
	);
