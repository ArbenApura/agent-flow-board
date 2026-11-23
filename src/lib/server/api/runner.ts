// THE REMOVED RUNNER API: AN OLDER BRIDGE THAT STILL CALLS /api/v1/runner/* GETS ONE PLAIN SENTENCE, NEVER A CRASH
// Browser checks were removed from Agent Flow Board (AFB-20261123-0936), and with them the runner calls (claim, peek, release, beat,
// artifacts, finish, approvals, sign-ins, dev status). Mockup addresses are minted with a personal token, not here. The answer is kept
// for one release so an installed bridge tells its person what to do.

// IMPORTED TYPES
import type { ApiRequest, ApiResponse } from './dispatch';
// IMPORTED MODULES
import { fail } from './respond';

// -- CONSTANTS -- //

export const RUNNER_API_GONE =
	'Browser checks were removed from Agent Flow Board. Update the skills with /flow-update-skills and the bridge with yarn or npm (@agent-flow-board/bridge), and stop calling the runner API.';

// -- FUNCTIONS -- //

/** Answers every runner call with 410 GONE. */
export async function handleRunnerApi(_req: ApiRequest): Promise<ApiResponse> {
	return fail(410, 'GONE', RUNNER_API_GONE);
}
