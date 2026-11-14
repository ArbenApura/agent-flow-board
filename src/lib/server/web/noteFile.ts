// SERVES ONE NOTE PICTURE TO A SIGNED IN PERSON WHO MAY SEE THE NOTE IT BELONGS TO (AFB-20261111-0035)
// The reader is checked against the picture's own note, never against the note whose text names it. Every refusal is the same
// 404, so an id cannot be used to find out whether a private note has pictures.

// IMPORTED TYPES
import type { DbHandle } from '../db/client';
import type { Storage } from '../adapters/storage';
// IMPORTED MODULES
import { OpError } from '../ops/context';
import { readNoteFile } from '../ops/notes';
import { orgForSlug } from '../orgs/orgs';

// -- CONSTANTS -- //

/** The headers of a picture: it cannot run as a page of this site (the same as /api/v1/files). */
const HEADERS = {
	'x-content-type-options': 'nosniff',
	'content-disposition': 'inline',
	'content-security-policy':
		"default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
	'cache-control': 'private, max-age=60',
	vary: 'cookie'
};

// -- FUNCTIONS -- //

export async function serveNoteFile(
	deps: { handle: DbHandle; storage: Storage | null },
	user: { id: string; name: string } | null,
	orgSlug: string,
	fileId: string,
	ifNoneMatch: string | null = null
): Promise<Response> {
	const gone = () =>
		new Response('Not found', {
			status: 404,
			headers: { ...HEADERS, 'content-type': 'text/plain' }
		});
	if (!user)
		return new Response('Sign in first', { status: 401, headers: { 'cache-control': 'no-store' } });
	if (!deps.storage) return gone();
	try {
		const org = await orgForSlug(deps.handle, orgSlug, user.id);
		if (!org) return gone();
		const file = await readNoteFile(
			{
				handle: deps.handle,
				orgId: org.id,
				services: { storage: deps.storage },
				actor: { userId: user.id, kind: 'person', label: user.name }
			},
			fileId
		);
		const etag = `"${file.checksum}"`;
		const headers = { ...HEADERS, etag, 'content-type': file.mime };
		if (ifNoneMatch === etag) return new Response(null, { status: 304, headers });
		return new Response(file.bytes as BodyInit, { status: 200, headers });
	} catch (e) {
		if (e instanceof OpError) return gone();
		throw e;
	}
}
