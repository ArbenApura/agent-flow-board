// IMPORTED DEP-TYPES
import type { PageServerLoad } from './$types';
// IMPORTED ENVS
import { AFB_ENABLE_GALLERY } from '$app/env/private';
// IMPORTED DEP-MODULES
import { error } from '@sveltejs/kit';

// -- FUNCTIONS -- //

/** The component gallery is a developer tool. A deployment never sets AFB_ENABLE_GALLERY, so it answers 404 there. */
export const load: PageServerLoad = () => {
	if (!AFB_ENABLE_GALLERY) error(404, 'Not found');
	return {};
};
