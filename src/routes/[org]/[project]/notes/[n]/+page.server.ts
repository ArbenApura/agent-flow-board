// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { error } from '@sveltejs/kit';
import { renderMarkdown } from '#lib/markdown.js';
import { OpError } from '#lib/server/ops/context.js';
import { listFolders } from '#lib/server/ops/noteFolders.js';
import { getNote, listNotes } from '#lib/server/ops/notes.js';
import { plainText } from '#lib/shared/noteExcerpt.js';
import { childContext, pageError } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/**
 * One note with the whole text rendered as sanitised Markdown. A note that is not there for this person (gone, in the trash,
 * private to someone else) is a 404 when the address is opened cold, and the "no longer available" panel when the page is
 * already open and the data is read again, so a note that was trashed under the reader does not turn the page into an error.
 */
export const load: PageServerLoad = async ({ params, parent, locals, depends, isDataRequest }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	if (!summary) error(404, 'Not found');
	const none = {
		gone: false,
		denied: null,
		folders: [],
		note: null,
		author: null as string | null,
		authorId: null as string | null,
		words: 0,
		siblings: [] as { id: string; ref: string; title: string; private: boolean }[],
		lastEditor: null as string | null,
		mine: false,
		favourite: false,
		canWrite: false,
		canDelete: false,
		canManage: false,
		publicEnabled: false,
		html: '',
		empty: true,
		markdown: ''
	};
	const ctx = await childContext(locals, org.id);
	try {
		const [found, tree] = await Promise.all([
			getNote(ctx, { project: params.project, note: params.n, full: true }),
			listFolders(ctx, { project: params.project })
		]);
		const n = found.note;
		// The notes beside this one, for In this folder (AFB-20261111-0805)
		const near = await listNotes(ctx, {
			project: params.project,
			folderId: n.folderId ?? null,
			brief: true,
			limit: 50
		});
		const words = plainText(found.body.text).split(' ').filter(Boolean).length;
		return {
			...none,
			folders: tree.folders,
			note: {
				id: n.id,
				ref: n.ref,
				title: n.title,
				folderId: n.folderId,
				private: n.visibility === 'private',
				updatedAt: n.updatedAt,
				createdAt: n.createdAt,
				version: n.version,
				epoch: n.epoch
			},
			author: found.author,
			authorId: n.createdBy,
			words,
			// The open note is always in the list, also when it is older than the 50 newest of its folder
			siblings: [
				...near.notes.map((s) => ({
					id: s.id,
					ref: s.ref,
					title: s.title,
					private: s.visibility === 'private'
				})),
				...(near.notes.some((s) => s.id === n.id)
					? []
					: [{ id: n.id, ref: n.ref, title: n.title, private: n.visibility === 'private' }])
			],
			lastEditor: found.lastEditor,
			mine: found.mine,
			favourite: found.favourite,
			canWrite: found.canWrite,
			canDelete: found.canDelete,
			canManage: found.canManage,
			publicEnabled: found.note.publicEnabled,
			// Text another person wrote is rendered as untrusted, so a guest-written note cannot carry markup
			html: renderMarkdown(found.body.text, {
				untrusted: found.untrusted,
				mode: 'note',
				linkBase: { org: org.slug, project: params.project }
			}),
			empty: found.body.total === 0,
			// The editor opens on the Markdown itself. Only a person who can write gets it, a reader gets the rendered html above
			markdown: found.canWrite ? found.body.text : ''
		};
	} catch (e) {
		if (e instanceof OpError && e.code === 'NOT_FOUND' && isDataRequest)
			return { ...none, gone: true };
		if (e instanceof OpError) return { ...none, ...pageError(e) };
		throw e;
	}
};
