// THE PUBLIC LINK OF A NOTE: FINDS THE NOTE AN ADDRESS NAMES AND SERVES ITS PICTURES (AFB-20261111-0035, 7.2)
// No session is read. The note row is reached only through the SELECT-only policy note_public_read, with the hash of the
// address set for the transaction, never with the owner role. A wrong address, a link that is off, a note in the trash and a
// private note all give null, and the first lookup costs the same in each case. The address is never logged.

// IMPORTED TYPES
import type { Storage } from '../adapters/storage';
import type { DbHandle } from '../db/client';
// IMPORTED DEP-MODULES
import { and, eq } from 'drizzle-orm';
// IMPORTED MODULES
import { hashToken as sha256 } from '../ops/mockups';
import { note, noteFile, project, user } from '../db/schema';
import { withTenant } from '../db/tenant';

// -- CONSTANTS -- //

/** The shape of an address the board makes (24 random bytes, base64url). Anything else is refused before the database. */
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;
const HEADERS = {
	'x-content-type-options': 'nosniff',
	'content-disposition': 'inline',
	'content-security-policy':
		"default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
	'referrer-policy': 'no-referrer',
	'x-robots-tag': 'noindex',
	'cache-control': 'no-store'
};

// -- TYPES -- //

export type PublicNote = {
	orgId: string;
	projectId: string;
	noteId: string;
	title: string;
	body: string;
	sharedBy: string;
	projectName: string;
	updatedAt: Date;
};

// -- FUNCTIONS -- //

/** The note a public address names, or null for every kind of failure. */
export async function findPublicNote(handle: DbHandle, token: string): Promise<PublicNote | null> {
	if (!TOKEN.test(token)) return null;
	const found = await withTenant(handle, { noteTokenHash: sha256(token) }, async (tx) => {
		const [n] = await tx.select().from(note);
		return n ?? null;
	});
	if (!found) return null;
	return withTenant(handle, { orgId: found.orgId, projectId: found.projectId }, async (tx) => {
		const [who] = found.createdBy
			? await tx.select({ name: user.name }).from(user).where(eq(user.id, found.createdBy))
			: [];
		const [proj] = await tx
			.select({ name: project.name })
			.from(project)
			.where(eq(project.id, found.projectId));
		return {
			orgId: found.orgId,
			projectId: found.projectId,
			noteId: found.id,
			title: found.title,
			body: found.body,
			sharedBy: who?.name ?? 'Someone',
			projectName: proj?.name ?? '',
			updatedAt: found.updatedAt
		};
	});
}

/** One picture under a public address. The picture must belong to the note the address names; any other case is a plain 404. */
export async function servePublicNoteFile(
	deps: { handle: DbHandle; storage: Storage | null },
	token: string,
	fileId: string
): Promise<Response> {
	const gone = () =>
		new Response('Not found', {
			status: 404,
			headers: { ...HEADERS, 'content-type': 'text/plain' }
		});
	try {
		if (!deps.storage || !TOKEN.test(token)) return gone();
		const key = await withTenant(deps.handle, { noteTokenHash: sha256(token) }, async (tx) => {
			const [n] = await tx.select({ id: note.id }).from(note);
			if (!n) return null;
			const [f] = await tx
				.select()
				.from(noteFile)
				.where(and(eq(noteFile.noteId, n.id), eq(noteFile.id, fileId)));
			return f ?? null;
		}).catch(() => null);
		if (!key) return gone();
		const bytes = await deps.storage.get(key.storageKey);
		if (!bytes) return gone();
		return new Response(bytes as BodyInit, {
			status: 200,
			headers: { ...HEADERS, 'content-type': key.mime }
		});
	} catch (e) {
		console.error('Public note picture failed', e instanceof Error ? e.message : e);
		return gone();
	}
}
