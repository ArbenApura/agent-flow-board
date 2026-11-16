// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
// IMPORTED ENVS
import { redirect } from '@sveltejs/kit';

// -- FUNCTIONS -- //

/** The Trash page now lives in Project settings. Old bookmarks and links land on its section. */
export const load: PageServerLoad = ({ params }) => {
	redirect(308, `/${params.org}/${params.project}/settings?tab=trash`);
};
