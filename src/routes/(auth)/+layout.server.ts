// IMPORTED DEP-TYPES
import type { LayoutServerLoad } from './$types';
// IMPORTED DEP-MODULES
import { redirect } from '@sveltejs/kit';

// -- FUNCTIONS -- //

/** People who are already signed in have no reason to see sign in, sign up or reset. Verify and invite stay open. */
export const load: LayoutServerLoad = ({ locals, url }) => {
	const open = url.pathname.startsWith('/verify') || url.pathname.startsWith('/invite');
	if (locals.user && !open) redirect(303, '/');
	return {};
};
