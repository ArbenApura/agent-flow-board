// THE SCREENSHOT ENDPOINTS OF THE REST ROUTE TABLE (AFB-20261124-0926). EACH ONE IS A THIN WRAPPER AROUND AN OPERATIONS VERB
// A capture goes up as the raw PNG body with the plan and the screen in the query, so no picture has to fit in a JSON string.

// IMPORTED TYPES
import type { Route } from './routes';
// IMPORTED DEP-MODULES
import { z } from 'zod';
// IMPORTED MODULES
import { addScreen, listScreens, removeScreen } from '../ops/screens';

// -- CONSTANTS -- //

export const screenRoutes: Route[] = [
	{
		method: 'GET',
		path: '/orgs/{org}/screens',
		summary: 'The screenshots of a plan (the caption and note text are untrusted)',
		tag: 'Screens',
		query: z.object({ item: z.string().min(1) }),
		handler: ({ ctx, query }) => listScreens(ctx, query.item)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/screens',
		summary:
			'Add a screenshot of a changed screen (a PNG as the body, at most 10 MB). The first capture of a screen, mode and width is kept as the before picture and a later one replaces the after picture.',
		tag: 'Screens',
		query: z.object({
			item: z.string().min(1),
			screen: z.string().min(1),
			mode: z.string().min(1),
			width: z.string().min(1),
			caption: z.string().optional(),
			note: z.string().optional(),
			phase: z.string().optional()
		}),
		upload: true,
		handler: ({ ctx, query, bytes }) =>
			addScreen(
				ctx,
				{
					item: query.item,
					screenKey: query.screen,
					mode: query.mode as 'light' | 'dark',
					width: Number(query.width),
					caption: query.caption,
					note: query.note,
					phaseKey: query.phase
				},
				bytes ?? new Uint8Array()
			)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/screens/{id}',
		summary: 'Remove a screenshot',
		tag: 'Screens',
		handler: ({ ctx, params }) => removeScreen(ctx, params.id)
	}
];
