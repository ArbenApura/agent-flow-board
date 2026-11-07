// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- MODULES -- //
import { redirect } from '@sveltejs/kit';

// -- FUNCTIONS -- //

/** The mockup settings page is gone (AFB-20261107-1337). An old bookmark goes to the Mockups page, built from the two names in the path. */
export const GET: RequestHandler = ({ params }) => {
	redirect(308, `/${encodeURIComponent(params.org)}/${encodeURIComponent(params.project)}/mockups`);
};
