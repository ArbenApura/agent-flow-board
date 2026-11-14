// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import { handleMcp } from '#lib/server/mcp/handler.js';
import { appServices } from '#lib/server/services.js';

// -- FUNCTIONS -- //

/** The deps of one request: the database and the outside services the tools may need. */
async function deps() {
	const s = await appServices();
	return {
		handle: await getDb(),
		storage: s.storage,
		baseUrl: s.baseUrl!,
		mockupSecret: s.mockupSecret,
		mockupOrigin: s.mockupOrigin
	};
}

/** The MCP endpoint of one organisation (/mcp/<slug>). The token must belong to that org, see handleMcp. */
export const POST: RequestHandler = async ({ request, params }) =>
	handleMcp(request, await deps(), params.org);
export const GET: RequestHandler = async ({ request, params }) =>
	handleMcp(request, await deps(), params.org);
export const DELETE: RequestHandler = async ({ request, params }) =>
	handleMcp(request, await deps(), params.org);
