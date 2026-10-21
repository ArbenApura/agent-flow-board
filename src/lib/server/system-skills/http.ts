// THE ANSWER OF A PUBLIC SYSTEM SKILLS ROUTE (AFB-20261021-0401): THE SAME BYTES FOR EVERY CALLER, SO A SHARED CACHE MAY KEEP THEM
// These routes skip the /api/v1 dispatcher on purpose: it turns every body into JSON and every answer into a private one.
// Nothing here reads a session, a cookie or a token, and nothing in a body is per person or per organisation.

// -- CONSTANTS -- //

const CACHE = 'public, max-age=300, must-revalidate';

// -- FUNCTIONS -- //

/** A 200 with a strong ETag, or a 304 when the caller already holds that version. */
export function publicAnswer(
	request: Request,
	body: BodyInit,
	o: { type: string; etag: string; filename?: string }
): Response {
	const etag = `"${o.etag}"`;
	const headers: Record<string, string> = {
		'content-type': o.type,
		etag,
		'cache-control': CACHE,
		// A public read that carries no credentials, so a page on another host may fetch it too
		'access-control-allow-origin': '*',
		'x-content-type-options': 'nosniff'
	};
	if (o.filename) headers['content-disposition'] = `attachment; filename="${o.filename}"`;
	if (request.headers.get('if-none-match') === etag)
		return new Response(null, { status: 304, headers });
	return new Response(body, { status: 200, headers });
}

export const notFound = () =>
	new Response(
		JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No such system skill file.' } }),
		{
			status: 404,
			headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
		}
	);
