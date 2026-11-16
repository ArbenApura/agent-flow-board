// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
// IMPORTED ENVS
import { redirect } from '@sveltejs/kit';

// -- FUNCTIONS -- //

/** The Activity page now lives in Project settings. Old bookmarks and session links land on its section. */
export const load: PageServerLoad = ({ params, url }) => {
	const session = url.searchParams.get('session');
	const query = session ? `&session=${encodeURIComponent(session)}` : '';
	redirect(308, `/${params.org}/${params.project}/settings?tab=activity${query}`);
};
