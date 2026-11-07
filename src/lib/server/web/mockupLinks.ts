// THE 5 MINUTE ADDRESSES OF MOCKUP FILES FOR A PAGE LOAD: THE LOADER ASKS AN OPERATION FOR THE CHECKED GRANT, THEN SIGNS IT HERE

// -- ENVS -- //
import { BETTER_AUTH_SECRET } from '$app/env/private';
// -- MODULES -- //
import { signMockupGrant, type MockupGrant } from '../mockups/serve';

// -- FUNCTIONS -- //

/** The relative address of one stored file of a mockup, signed for 5 minutes. */
export const memberMockupUrl = (grant: MockupGrant) => signMockupGrant(BETTER_AUTH_SECRET, grant);
