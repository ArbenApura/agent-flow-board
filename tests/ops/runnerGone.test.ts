// THE REMOVED RUNNER API: AN OLDER BRIDGE THAT STILL CALLS /api/v1/runner/* GETS 410 AND ONE PLAIN SENTENCE (AFB-20261123-0936)

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { handleRunnerApi, RUNNER_API_GONE } from '../../src/lib/server/api/runner';

// -- FUNCTIONS -- //

describe('the removed runner API', () => {
	it('answers every call with 410 GONE and says what to do, whatever the method and the path', async () => {
		for (const [method, path] of [
			['POST', '/runner/claim'],
			['POST', '/runner/runs/abc/finish'],
			['GET', '/runner/runs/abc/accounts'],
			['POST', '/runner/mockups/abc/url']
		] as const) {
			const res = await handleRunnerApi({
				method,
				path,
				query: {},
				headers: new Headers(),
				body: new Uint8Array(),
				session: null
			} as never);
			expect(res.status, `${method} ${path}`).toBe(410);
			expect(res.body).toEqual({ error: { code: 'GONE', message: RUNNER_API_GONE } });
			expect(RUNNER_API_GONE).toMatch(/update the skills/i);
		}
	});
});
