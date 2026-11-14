// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';

// -- FUNCTIONS -- //

/** Liveness and version for the Docker health check, the build preview runner and the deployed target. */
export const GET: RequestHandler = () =>
	new Response(JSON.stringify({ ok: true, service: 'agent-flow-board' }), {
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});
