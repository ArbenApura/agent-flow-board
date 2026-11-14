// IMPORTED DEP-TYPES
import type { RequestHandler } from './$types';
// IMPORTED DEP-MODULES
import { error } from '@sveltejs/kit';
// IMPORTED ENVS
import { BETTER_AUTH_SECRET } from '$app/env/private';
// IMPORTED MODULES
import { getStorage } from '#lib/server/adapters/index.js';
import { verifySignedFile } from '#lib/server/adapters/storage.js';
import { isMockupKey } from '#lib/server/mockups/keys.js';

// -- FUNCTIONS -- //

/** Serves one stored file for a valid signed link and nothing else. Wrong, changed or expired links answer 404. */
export const GET: RequestHandler = async ({ params, url }) => {
	const store = getStorage();
	// Mockup files are served only by the mockup routes, which send the isolating headers
	if (isMockupKey(params.key)) error(404, 'Not found');
	const exp = Number(url.searchParams.get('exp'));
	const sig = url.searchParams.get('sig') ?? '';
	if (!store || !verifySignedFile(fileSecret(), params.key, exp, sig)) error(404, 'Not found');
	const bytes = await store.get(params.key);
	if (!bytes) error(404, 'Not found');
	const ext = params.key.split('.').pop()?.toLowerCase() ?? '';
	const inline = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf', 'mp4', 'webm', 'txt'].includes(ext);
	return new Response(bytes as BodyInit, {
		headers: {
			'content-type': mimeFor(ext),
			// Everything else downloads, and nothing can run as a page of this site
			'content-disposition': inline ? 'inline' : 'attachment',
			'x-content-type-options': 'nosniff',
			'content-security-policy':
				"default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
			'cache-control': 'private, max-age=60'
		}
	});
};

function fileSecret() {
	return BETTER_AUTH_SECRET;
}

function mimeFor(ext: string): string {
	const map: Record<string, string> = {
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		webp: 'image/webp',
		gif: 'image/gif',
		pdf: 'application/pdf',
		mp4: 'video/mp4',
		webm: 'video/webm',
		txt: 'text/plain; charset=utf-8',
		csv: 'text/csv',
		json: 'application/json',
		md: 'text/plain; charset=utf-8',
		html: 'text/plain; charset=utf-8'
	};
	return map[ext] ?? 'application/octet-stream';
}
