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

/** The MCP endpoint. Every request is self contained, so it works behind any number of server processes. */
export const POST: RequestHandler = async ({ request }) => handleMcp(request, await deps());
export const GET: RequestHandler = async ({ request }) => handleMcp(request, await deps());
export const DELETE: RequestHandler = async ({ request }) => handleMcp(request, await deps());
