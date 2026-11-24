// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED DEP-MODULES
import { error } from '@sveltejs/kit';
// IMPORTED MODULES
import { getStorage } from '#lib/server/adapters/index.js';
import { getDb } from '#lib/server/db/index.js';
import { readProjectPicture, readUserPicture } from '#lib/server/ops/pictures.js';
import { readScreenImage } from '#lib/server/ops/screens.js';

// -- CONSTANTS -- //

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -- FUNCTIONS -- //

/**
 * Serves one avatar or project logo to a signed in person who may see it. A wrong kind, an unknown id, a picture the
 * caller may not see and a missing picture all answer 404, so an id cannot be used to probe other organisations.
 */
export const GET: RequestHandler = async ({ params, url, locals, request }) => {
	if (!locals.user) error(401, 'Sign in first');
	const handle = await getDb();
	// A plan's screenshot (AFB-20261124-0926): a PNG read through the plan's own visibility, with the isolating headers
	if (params.kind === 'screen') {
		const store = getStorage();
		if (!store || !UUID.test(params.id)) error(404, 'Not found');
		const shot = await readScreenImage(handle, store, locals.user.id, params.id);
		if (!shot) error(404, 'Not found');
		const tag = `"${shot.checksum}"`;
		const shotHeaders = {
			etag: tag,
			'content-type': 'image/png',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; img-src 'self' data:; sandbox",
			// Every request is checked again; the ETag makes an unchanged picture a cheap 304
			'cache-control': 'private, no-cache',
			vary: 'cookie'
		};
		if (request.headers.get('if-none-match') === tag)
			return new Response(null, { status: 304, headers: shotHeaders });
		return new Response(shot.bytes as BodyInit, { status: 200, headers: shotHeaders });
	}
	let picture = null;
	if (params.kind === 'user' && /^[A-Za-z0-9_-]{1,64}$/.test(params.id))
		picture = await readUserPicture(handle, locals.user.id, params.id);
	else if (params.kind === 'project' && UUID.test(params.id))
		picture = await readProjectPicture(handle, locals.user.id, params.id);
	if (!picture) error(404, 'Not found');
	const etag = `"${picture.version}"`;
	// The address carries the version, so a changed picture is a new address and the old one can stay cached for good
	const headers = {
		etag,
		'content-type': picture.mime,
		'x-content-type-options': 'nosniff',
		'content-security-policy': "default-src 'none'; img-src 'self' data:; sandbox",
		'cache-control': url.searchParams.has('v')
			? 'private, max-age=31536000, immutable'
			: 'private, no-cache',
		vary: 'cookie'
	};
	if (request.headers.get('if-none-match') === etag)
		return new Response(null, { status: 304, headers });
	return new Response(picture.bytes as BodyInit, { status: 200, headers });
};
