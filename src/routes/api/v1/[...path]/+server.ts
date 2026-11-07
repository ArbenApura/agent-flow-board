// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- ENVS -- //
// -- MODULES -- //
import { bodyLimit, readBodyCapped } from '#lib/server/api/body.js';
import { handleApi } from '#lib/server/api/dispatch.js';
import { appServices } from '#lib/server/services.js';
import { getDb } from '#lib/server/db/index.js';

// -- FUNCTIONS -- //

/** One handler for every method. The dispatcher owns routing, auth, validation and errors. */
const handler: RequestHandler = async ({ request, params, url, locals }) => {
	const path = '/' + params.path.replace(/\/+$/, '');
	// The body is read up to this endpoint's limit only, so a mockup upload is cut at its cap while it streams in
	const limit = bodyLimit(request.method, path);
	const bytes = limit === 0 ? new Uint8Array() : await readBodyCapped(request, limit);
	if (!bytes)
		return new Response(
			JSON.stringify({
				error: { code: 'INVALID', message: 'The request body is larger than this endpoint allows.' }
			}),
			{ status: 413, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
		);
	const services = await appServices();
	const res = await handleApi(
		{
			method: request.method,
			path,
			query: Object.fromEntries(url.searchParams),
			headers: request.headers,
			origin: url.origin,
			body: bytes,
			session: locals.user ? { id: locals.user.id, name: locals.user.name } : null
		},
		{
			handle: await getDb(),
			storage: services.storage,
			baseUrl: services.baseUrl!,
			mailer: services.mailer,
			jobs: services.jobs,
			masterKey: services.masterKey,
			runnerQueueMinutes: services.runnerQueueMinutes
		}
	);
	const text = JSON.stringify(res.body);
	// A successful read carries an ETag, so a client that asks again with If-None-Match gets a 304 and no body.
	// The answer depends on who asks, so it is private and must be revalidated every time.
	if (request.method === 'GET' && res.status === 200) {
		const etag = await etagOf(text);
		const headers = {
			'content-type': 'application/json',
			...res.headers,
			etag,
			'cache-control': res.headers?.['cache-control']?.startsWith('public')
				? res.headers['cache-control']
				: 'private, no-cache',
			vary: 'authorization, cookie'
		};
		if (request.headers.get('if-none-match') === etag)
			return new Response(null, { status: 304, headers });
		return new Response(text, { status: 200, headers });
	}
	return new Response(text, {
		status: res.status,
		headers: { 'content-type': 'application/json', ...res.headers }
	});
};

/** A weak validator from a SHA-1 of the body (Web Crypto). */
async function etagOf(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
	return `W/"${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
}

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const PUT = handler;
export const DELETE = handler;
