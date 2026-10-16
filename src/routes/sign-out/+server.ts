// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- DEP-MODULES -- //
import { redirect } from '@sveltejs/kit';
// -- MODULES -- //
import { getAuth } from '#lib/server/auth/index.js';

// -- FUNCTIONS -- //

/** Signing out is a POST, so a link or an image on another site cannot sign anyone out. */
export const POST: RequestHandler = async ({ request }) => {
	await (await getAuth()).api.signOut({ headers: request.headers });
	redirect(303, '/sign-in');
};
