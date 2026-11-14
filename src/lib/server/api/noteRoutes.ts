// THE NOTE ENDPOINTS OF THE REST ROUTE TABLE (AFB-20261111-0035). EACH ONE IS A THIN WRAPPER AROUND AN OPERATIONS VERB
// The cause of a body change is worked out here from the caller (a person at the screens is typing, a token is an outside
// program) and is never read from what the caller sent.

// IMPORTED TYPES
import type { Route } from './routes';
// IMPORTED DEP-MODULES
import { z } from 'zod';
// IMPORTED MODULES
import { OpError } from '../ops/context';
import {
	createFolder,
	folderNewInput,
	listFolders,
	moveFolder,
	renameFolder,
	restoreFolder,
	trashFolder
} from '../ops/noteFolders';
import {
	createNote,
	getNote,
	getNoteLinks,
	linkNote,
	listNotes,
	listNotesLinkedTo,
	noteCauseOf,
	noteChangeInput,
	noteLinkVerbInput,
	noteNewInput,
	restoreNote,
	searchLinkTargets,
	setFavourite,
	trashNote,
	unlinkNote,
	updateNote,
	uploadNoteFile
} from '../ops/notes';

// -- CONSTANTS -- //

/** A whole number from the query, or INVALID, so a stray letter is a 400 and never reaches the database as NaN. */
const num = (v: string | undefined, name: string, min = 0) => {
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isInteger(n) || n < min)
		throw new OpError('INVALID', `The ${name} must be a whole number of ${min} or more.`);
	return n;
};
const bool = (v: string | undefined) => v === 'true' || v === '1';
const without = <T extends z.ZodRawShape>(s: z.ZodObject<T>, ...keys: string[]) =>
	s.omit(Object.fromEntries(keys.map((k) => [k, true])) as never) as z.ZodType;

const linkBody = noteLinkVerbInput.omit({ project: true, note: true });

const NOTES = '/orgs/{org}/projects/{project}/notes';
const FOLDERS = '/orgs/{org}/projects/{project}/note-folders';

export const noteRoutes: Route[] = [
	// -- notes -- //
	{
		method: 'GET',
		path: NOTES,
		summary:
			'List the notes of a project you may see, newest change first. folder is a folder id, or "top" for the notes in no folder; favourites=true gives your starred notes; q searches titles and text',
		tag: 'Notes',
		handler: ({ ctx, params, query }) =>
			listNotes(ctx, {
				project: params.project,
				folderId:
					query.folder === undefined ? undefined : query.folder === 'top' ? null : query.folder,
				favourites: bool(query.favourites) || undefined,
				q: query.q,
				limit: num(query.limit, 'limit', 1),
				offset: num(query.offset, 'offset')
			})
	},
	{
		method: 'POST',
		path: NOTES,
		summary: 'Create a note. The answer is its reference and version, never the text',
		tag: 'Notes',
		body: without(noteNewInput, 'project'),
		handler: ({ ctx, params, body }) =>
			createNote(
				ctx,
				{ ...(body as object), project: params.project } as never,
				noteCauseOf(ctx.actor, 'api')
			)
	},
	// Before {note}, so "link-targets" is never taken for a note name
	{
		method: 'GET',
		path: `${NOTES}/link-targets`,
		summary:
			'Plans, tasks, mockups and notes of the project whose title contains q (at most 10 in all), each only if you may see it. Guests get an empty list',
		tag: 'Notes',
		handler: ({ ctx, params, query }) =>
			searchLinkTargets(ctx, { project: params.project, q: query.q ?? '' })
	},
	// Before {note}, so "linked-to" is never taken for a note name
	{
		method: 'GET',
		path: `${NOTES}/linked-to`,
		summary:
			'The notes you may see that link to a plan, task or mockup: kind is item, task or mockup, target its reference (AFB-20261107-0346, T-4) or id. Guests get an empty list',
		tag: 'Notes',
		handler: ({ ctx, params, query }) =>
			listNotesLinkedTo(ctx, {
				project: params.project,
				targetKind: query.kind as never,
				target: query.target ?? ''
			})
	},
	{
		method: 'GET',
		path: `${NOTES}/{note}/links`,
		summary:
			'What a note links to (plans, tasks, mockups, notes; from the Links panel or its text) and the notes that mention it, each only if you may see it, with counts',
		tag: 'Notes',
		handler: ({ ctx, params }) => getNoteLinks(ctx, { project: params.project, note: params.note })
	},
	{
		method: 'POST',
		path: `${NOTES}/{note}/links`,
		summary:
			'Link a note to a plan, task, mockup or another note of the same project (targetKind item, task, mockup or note; target a reference or id). Linking twice changes nothing',
		tag: 'Notes',
		body: linkBody,
		handler: ({ ctx, params, body }) =>
			linkNote(ctx, { ...(body as object), project: params.project, note: params.note } as never)
	},
	{
		method: 'DELETE',
		path: `${NOTES}/{note}/links`,
		summary:
			'Remove a Links panel link: targetKind and target as query values. A link written in the text stays until the text changes',
		tag: 'Notes',
		handler: ({ ctx, params, query }) =>
			unlinkNote(ctx, {
				project: params.project,
				note: params.note,
				targetKind: query.targetKind as never,
				target: query.target ?? ''
			})
	},
	{
		method: 'POST',
		path: `${NOTES}/{note}/files`,
		summary:
			'Add a picture to a note: the picture itself as the body (PNG, JPEG, WebP or GIF, at most 25 MB; SVG is refused). The answer holds the id and the Markdown to write in the text, ![](afb:file/<id>)',
		tag: 'Notes',
		upload: true,
		handler: ({ ctx, params, bytes }) =>
			uploadNoteFile(ctx, { project: params.project, note: params.note }, bytes ?? new Uint8Array())
	},
	{
		method: 'GET',
		path: `${NOTES}/{note}`,
		summary:
			'One note by reference (N-12) or id, with a page of its text from offset (full=true for all of it), who wrote it and what you may do with it. Text another person wrote is marked untrusted',
		tag: 'Notes',
		handler: ({ ctx, params, query }) =>
			getNote(ctx, {
				project: params.project,
				note: params.note,
				offset: num(query.offset, 'offset'),
				full: bool(query.full)
			})
	},
	{
		method: 'PATCH',
		path: `${NOTES}/{note}`,
		summary:
			'Change the title, the text, the folder (null for the top) or the visibility of a note. With expectVersion the change is refused when the note moved on',
		tag: 'Notes',
		body: without(noteChangeInput, 'project', 'note'),
		handler: ({ ctx, params, body }) =>
			updateNote(
				ctx,
				{ ...(body as object), project: params.project, note: params.note } as never,
				// Only the live checkpoint writes a body as typing; a body sent here, from any caller, is an outside write
				// that keeps a version and moves the epoch, so an open window cannot overwrite it at its next checkpoint
				body && typeof body === 'object' && 'body' in body ? 'api' : noteCauseOf(ctx.actor, 'api')
			)
	},
	{
		method: 'DELETE',
		path: `${NOTES}/{note}`,
		summary: 'Move a note to the trash for 30 days. Its public link stops',
		tag: 'Notes',
		handler: ({ ctx, params }) => trashNote(ctx, { project: params.project, note: params.note })
	},
	{
		method: 'POST',
		path: `${NOTES}/{note}/restore`,
		summary: 'Restore a note from the trash',
		tag: 'Notes',
		handler: ({ ctx, params }) => restoreNote(ctx, { project: params.project, note: params.note })
	},
	{
		method: 'PUT',
		path: `${NOTES}/{note}/favourite`,
		summary: 'Star or unstar a note for yourself',
		tag: 'Notes',
		body: z.object({ on: z.boolean() }),
		handler: ({ ctx, params, body }) =>
			setFavourite(ctx, {
				project: params.project,
				note: params.note,
				on: (body as { on: boolean }).on
			})
	},
	// -- folders -- //
	{
		method: 'GET',
		path: FOLDERS,
		summary:
			'The folder tree of a project in path order, with the notes you may see in each folder',
		tag: 'Notes',
		handler: ({ ctx, params }) => listFolders(ctx, { project: params.project })
	},
	{
		method: 'POST',
		path: FOLDERS,
		summary: 'Create a folder, at the top or inside another one (parentId)',
		tag: 'Notes',
		body: without(folderNewInput, 'project'),
		handler: ({ ctx, params, body }) =>
			createFolder(ctx, { ...(body as object), project: params.project } as never)
	},
	{
		method: 'PATCH',
		path: `${FOLDERS}/{folder}`,
		summary:
			'Rename a folder (name) or move it (parentId, null for the top), one at a time. A move into itself or a folder inside it is refused',
		tag: 'Notes',
		body: z
			.object({ name: z.string().optional(), parentId: z.string().uuid().nullable().optional() })
			// One change per request: both under one Idempotency-Key would replay the first verb's result for the second
			.refine((v) => (v.name !== undefined) !== (v.parentId !== undefined), {
				message: 'Send a name or a parentId, one at a time.'
			}),
		handler: async ({ ctx, params, body }) => {
			const input = body as { name?: string; parentId?: string | null };
			const where = { project: params.project, folder: params.folder };
			if (input.parentId !== undefined)
				return moveFolder(ctx, { ...where, parentId: input.parentId });
			return renameFolder(ctx, { ...where, name: input.name as string });
		}
	},
	{
		method: 'DELETE',
		path: `${FOLDERS}/{folder}`,
		summary:
			'Move a folder to the trash for 30 days. Everything under it is hidden with it and comes back with a restore',
		tag: 'Notes',
		handler: ({ ctx, params }) =>
			trashFolder(ctx, { project: params.project, folder: params.folder })
	},
	{
		method: 'POST',
		path: `${FOLDERS}/{folder}/restore`,
		summary: 'Restore a folder from the trash, with everything under it',
		tag: 'Notes',
		handler: ({ ctx, params }) =>
			restoreFolder(ctx, { project: params.project, folderId: params.folder })
	}
];
