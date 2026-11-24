// THE SCREENSHOT ENDPOINTS OF THE REST ROUTE TABLE (AFB-20261124-0926). EACH ONE IS A THIN WRAPPER AROUND AN OPERATIONS VERB
// A capture goes up as the raw PNG body with the plan and the screen in the query, so no picture has to fit in a JSON string.

// IMPORTED TYPES
import type { Route } from './routes';
// IMPORTED DEP-MODULES
import { z } from 'zod';
// IMPORTED MODULES
import { screenAnnotationInput } from '../db/zod';
import {
	addScreen,
	addScreenAnnotation,
	listScreens,
	removeScreen,
	removeScreenAnnotation,
	setScreenAnnotationResolved
} from '../ops/screens';

// -- CONSTANTS -- //

export const screenRoutes: Route[] = [
	{
		method: 'GET',
		path: '/orgs/{org}/screens',
		summary:
			'The screenshots of a plan with their annotations (the caption, note and annotation text are untrusted)',
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
		summary: 'Remove a screenshot with its annotations',
		tag: 'Screens',
		handler: ({ ctx, params }) => removeScreen(ctx, params.id)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/screen-annotations',
		summary:
			'Add a pin, a box or an arrow to a screenshot. Coordinates are fractions of the picture, 0 to 1; a box or an arrow has w and h (an arrow runs from x, y to x + w, y + h).',
		tag: 'Screens',
		body: screenAnnotationInput,
		handler: ({ ctx, body }) => addScreenAnnotation(ctx, body as never)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/screen-annotations/{id}/resolve',
		summary: 'Mark an annotation done (resolved true) or open again (resolved false)',
		tag: 'Screens',
		body: z.object({ resolved: z.boolean() }),
		handler: ({ ctx, params, body }) =>
			setScreenAnnotationResolved(ctx, params.id, (body as { resolved: boolean }).resolved)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/screen-annotations/{id}',
		summary: 'Remove an annotation',
		tag: 'Screens',
		handler: ({ ctx, params }) => removeScreenAnnotation(ctx, params.id)
	}
];
