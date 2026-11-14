// THE NOTE HISTORY AND PUBLIC LINK ENDPOINTS OF THE REST ROUTE TABLE (AFB-20261111-0035, 7.1 AND 7.2)

// IMPORTED TYPES
import type { Route } from './routes';
// IMPORTED DEP-MODULES
import { z } from 'zod';
// IMPORTED MODULES
import { OpError } from '../ops/context';
import {
	getNoteVersion,
	listNoteVersions,
	restoreNoteVersion,
	setNotePublicLink
} from '../ops/noteVersions';

// -- CONSTANTS -- //

const NOTES = '/orgs/{org}/projects/{project}/notes';

/** A whole number from the path or query, or INVALID, so a stray letter is a 400 and never reaches the database as NaN. */
const whole = (v: string | undefined, name: string, min = 0) => {
	const n = Number(v);
	if (v === undefined || !Number.isInteger(n) || n < min)
		throw new OpError('INVALID', `The ${name} must be a whole number of ${min} or more.`);
	return n;
};

export const noteVersionRoutes: Route[] = [
	{
		method: 'GET',
		path: `${NOTES}/{note}/versions`,
		summary:
			'The earlier versions of a note, newest first, without their text: number, title, why it was kept (typing, agent, api or restore), who wrote it and when',
		tag: 'Notes',
		handler: ({ ctx, params, query }) =>
			listNoteVersions(ctx, {
				project: params.project,
				note: params.note,
				limit: query.limit === undefined ? undefined : whole(query.limit, 'limit', 1),
				offset: query.offset === undefined ? undefined : whole(query.offset, 'offset')
			})
	},
	{
		method: 'GET',
		path: `${NOTES}/{note}/versions/{number}`,
		summary: 'One earlier version of a note with its whole text',
		tag: 'Notes',
		handler: ({ ctx, params }) =>
			getNoteVersion(ctx, {
				project: params.project,
				note: params.note,
				number: whole(params.number, 'version', 1)
			})
	},
	{
		method: 'POST',
		path: `${NOTES}/{note}/versions/{number}/restore`,
		summary:
			'Copy an earlier version on top as the newest. The current text is kept as a version first, so a restore can be taken back. With expectVersion the restore is refused when the note moved on',
		tag: 'Notes',
		body: z.object({ expectVersion: z.number().int().optional() }),
		handler: ({ ctx, params, body }) =>
			restoreNoteVersion(ctx, {
				project: params.project,
				note: params.note,
				number: whole(params.number, 'version', 1),
				expectVersion: (body as { expectVersion?: number } | undefined)?.expectVersion
			})
	},
	{
		method: 'POST',
		path: `${NOTES}/{note}/public-link`,
		summary:
			'Switch the public link of a shared note on (a new address every time, shown once) or off. Needs the manage capability. A private note has no link',
		tag: 'Notes',
		body: z.object({ on: z.boolean() }),
		handler: ({ ctx, params, body }) =>
			setNotePublicLink(ctx, {
				project: params.project,
				note: params.note,
				on: (body as { on: boolean }).on
			})
	}
];
