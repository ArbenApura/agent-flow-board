// THE LIVE EDITING ENDPOINTS OF A NOTE (AFB-20261111-0035, 8.2). THIN WRAPPERS AROUND THE VERBS IN ops/noteSync.ts
// They are for the open page: JSON only, this site's Origin for a cookie caller (see `live` on Route), their own rate bucket.

// IMPORTED TYPES
import type { Route } from './routes';
// IMPORTED MODULES
import {
	appendNoteUpdates,
	checkpointNote,
	noteCheckpointInput,
	notePresenceInput,
	noteUpdatesInput,
	readNoteUpdates,
	sendNotePresence
} from '../ops/noteSync';

// -- CONSTANTS -- //

const LIVE = '/orgs/{org}/projects/{project}/notes/{note}/live';
const where = (params: Record<string, string>) => ({ project: params.project, note: params.note });

export const noteSyncRoutes: Route[] = [
	{
		method: 'POST',
		path: `${LIVE}/updates`,
		summary:
			'Live editing: store Yjs updates (base64) of a note in the given epoch. A seed is the one update with seed=true. The answer lists the numbers taken, or says epoch or taken',
		tag: 'Notes',
		live: true,
		// Only the open page edits live: a token write would skip the forced version and the epoch bump
		sessionOnly: true,
		body: noteUpdatesInput.omit({ project: true, note: true }),
		handler: ({ ctx, params, body }) =>
			appendNoteUpdates(ctx, { ...(body as object), ...where(params) } as never)
	},
	{
		method: 'GET',
		path: `${LIVE}/updates`,
		summary:
			'Live editing: the epoch, the Markdown and the live updates of a note after the number given in the query (after)',
		tag: 'Notes',
		live: true,
		// Only the open page edits live: a token write would skip the forced version and the epoch bump
		sessionOnly: true,
		handler: ({ ctx, params, query }) =>
			readNoteUpdates(ctx, {
				...where(params),
				after: query.after === undefined ? 0 : Number(query.after)
			})
	},
	{
		method: 'POST',
		path: `${LIVE}/checkpoint`,
		summary:
			'Live editing: save the Markdown of the live document as the note body. Taken only for the current epoch and a newer sequence',
		tag: 'Notes',
		live: true,
		// Only the open page edits live: a token write would skip the forced version and the epoch bump
		sessionOnly: true,
		body: noteCheckpointInput.omit({ project: true, note: true }),
		handler: ({ ctx, params, body }) =>
			checkpointNote(ctx, { ...(body as object), ...where(params) } as never)
	},
	{
		method: 'POST',
		path: `${LIVE}/presence`,
		summary: 'Live editing: pass one presence message (a cursor, a name) to the other open windows',
		tag: 'Notes',
		live: true,
		// Only the open page edits live: a token write would skip the forced version and the epoch bump
		sessionOnly: true,
		body: notePresenceInput.omit({ project: true, note: true }),
		handler: ({ ctx, params, body }) =>
			sendNotePresence(ctx, { ...(body as object), ...where(params) } as never)
	}
];
