// -- DEP-TYPES -- //
import type { PageServerLoad } from './$types';
// -- MODULES -- //
import { NOTES_LAYOUT_COOKIE, parseNotesLayout, readNotesView } from '#lib/board/notes/view.js';
import { OpError } from '#lib/server/ops/context.js';
import { listFolders } from '#lib/server/ops/noteFolders.js';
import { listNotes } from '#lib/server/ops/notes.js';
import { childContext, pageError } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/**
 * The folder tree and the notes of the open view, read side by side. Notes are not shared with guests, so a guest on the
 * project gets the permission panel. Refetched when the live stream reports a change.
 */
export const load: PageServerLoad = async ({ params, parent, locals, depends, url, cookies }) => {
	depends('afb:project');
	const { org, summary } = await parent();
	const asked = readNotesView(url.searchParams);
	// The person's last choice of List or Cards, so the first render is already right (AFB-20261111-1344)
	const savedLayout = parseNotesLayout(cookies.get(NOTES_LAYOUT_COOKIE));
	const none = {
		savedLayout,
		folders: [],
		total: 0,
		favourites: 0,
		notes: [],
		more: false,
		view: asked,
		canWrite: false,
		canDelete: false
	};
	if (!summary) return { ...none, denied: null };
	const ctx = await childContext(locals, org.id);
	try {
		const [tree, list] = await Promise.all([
			listFolders(ctx, { project: params.project }),
			listNotes(ctx, {
				project: params.project,
				folderId: asked.view === 'folder' ? asked.folderId : undefined,
				favourites: asked.view === 'favourites' || undefined,
				q: asked.q || undefined,
				limit: 200
			})
		]);
		// A folder that is gone or in the trash shows as an empty folder until the person picks another
		return {
			savedLayout,
			folders: tree.folders,
			total: tree.top + tree.folders.reduce((sum, f) => sum + f.notes, 0),
			favourites: tree.favourites,
			notes: list.notes.map((n) => ({
				id: n.id,
				ref: n.ref,
				title: n.title,
				folderId: n.folderId,
				private: n.visibility === 'private',
				mine: n.mine,
				favourite: n.favourite,
				excerpt: n.excerpt,
				match: n.match,
				lastEditor: n.lastEditor,
				updatedAt: n.updatedAt
			})),
			more: list.next !== null,
			view: asked,
			canWrite: summary.caps.includes('write'),
			canDelete: summary.caps.includes('delete'),
			denied: null
		};
	} catch (e) {
		if (e instanceof OpError) return { ...none, ...pageError(e) };
		throw e;
	}
};
