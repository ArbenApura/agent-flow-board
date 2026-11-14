// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED DEP-MODULES
import { redirect } from '@sveltejs/kit';
// IMPORTED MODULES
import { getAuth } from '#lib/server/auth/index.js';
import { safeNext } from '#lib/server/auth/next.js';

// -- FUNCTIONS -- //

/** Signing out is a POST, so a link or an image on another site cannot sign anyone out. */
export const POST: RequestHandler = async ({ request, url }) => {
	await (await getAuth()).api.signOut({ headers: request.headers });
	// A page can ask to be the place to come back to after the next sign in (a path on this site only)
	const next = safeNext(url.searchParams.get('next'));
	redirect(303, next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`);
};
