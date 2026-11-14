// THE 5 MINUTE ADDRESSES OF MOCKUP FILES FOR A PAGE LOAD: THE LOADER ASKS AN OPERATION FOR THE CHECKED GRANT, THEN SIGNS IT HERE

// -- ENVS -- //
import { BETTER_AUTH_SECRET, MOCKUP_ORIGIN } from '$app/env/private';
// -- MODULES -- //
import { buildMockupUrl } from '../mockups/origin';
import { signMockupGrant, type MockupGrant } from '../mockups/serve';

// -- FUNCTIONS -- //

/** The signed address of one stored file of a mockup, bound to MOCKUP_ORIGIN when configured (relative in local dev otherwise). */
export const memberMockupUrl = (grant: MockupGrant) =>
	buildMockupUrl(signMockupGrant(BETTER_AUTH_SECRET, grant), MOCKUP_ORIGIN);
