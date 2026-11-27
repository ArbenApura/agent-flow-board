// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
// IMPORTED DEP-MODULES
import { redirect } from '@sveltejs/kit';

// -- FUNCTIONS -- //

/** The QA map's old address lands on the Testing page that replaced it (AFB-20261127-0438). */
export const load: PageServerLoad = ({ params }) => {
	redirect(301, `/${params.org}/${params.project}/testing`);
};
