// THE MOCKUP ENDPOINTS OF THE REST ROUTE TABLE (AFB-20261107-0346). EACH ONE IS A THIN WRAPPER AROUND AN OPERATIONS VERB
// A published file goes up as the raw body with the plan and title in the query. Notes, screenshot and settings are their own calls,
// so no text has to fit in an address.

// -- TYPES -- //
import type { Route } from './routes';
// -- DEP-MODULES -- //
import { z } from 'zod';
// -- MODULES -- //
import { OpError } from '../ops/context';
import { addMockupPin, listMockupPins, pinInput, removeMockupPin } from '../ops/mockupPins';
import {
	deleteMockupTemplate,
	getMockupSettings,
	kitInput,
	readMockupKit,
	saveMockupTemplate,
	setMockupKit,
	setMockupStyle,
	styleInput,
	templateInput
} from '../ops/mockupSettings';
import {
	getMockup,
	linkMockup,
	listMockups,
	publishInput,
	publishMockup,
	readMockupHtml,
	restoreMockupFromTrash,
	restoreMockupVersion,
	setMockupPublicLink,
	setVersionNotes,
	setVersionScreenshot,
	trashMockup
} from '../ops/mockups';

// -- CONSTANTS -- //

/** A whole number from the address or the query, or INVALID, so a stray letter is a 400 and never reaches the database as NaN. */
const num = (v: string | undefined, name = 'value', min = 1) => {
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isInteger(n) || n < min)
		throw new OpError('INVALID', `The ${name} must be a whole number of ${min} or more.`);
	return n;
};
const bool = (v: string | undefined) => v === 'true' || v === '1';
const noProject = <T extends z.ZodRawShape>(s: z.ZodObject<T>) =>
	s.omit({ project: true } as never) as z.ZodType;

export const mockupRoutes: Route[] = [
	// -- mockups -- //
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{project}/mockups',
		summary: 'List the mockups of a project you may see',
		tag: 'Mockups',
		handler: ({ ctx, params, query }) =>
			listMockups(ctx, {
				project: params.project,
				item: query.item,
				q: query.q,
				trashed: bool(query.trashed)
			})
	},
	{
		method: 'POST',
		path: '/orgs/{org}/mockups',
		summary:
			'Publish a mockup file (HTML as the body). Name the plan with item, or a project, or an existing mockup for a new version. The answer carries warnings, a list of plain words about what will not render (empty when nothing is wrong).',
		tag: 'Mockups',
		query: publishInput.omit({ keepNotes: true, freeNotes: true }),
		upload: true,
		handler: ({ ctx, query, bytes }) =>
			publishMockup(
				ctx,
				{
					item: query.item,
					project: query.project,
					mockup: query.mockup,
					another: bool(query.another),
					title: query.title
				},
				bytes ?? new Uint8Array()
			)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/mockups/{id}',
		summary: 'One mockup with its versions and the build notes of the current one (untrusted text)',
		tag: 'Mockups',
		handler: ({ ctx, params }) => getMockup(ctx, params.id)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/mockups/{id}/html',
		summary: 'The HTML of one version, or a part of it (untrusted text)',
		tag: 'Mockups',
		handler: ({ ctx, params, query }) =>
			readMockupHtml(ctx, params.id, {
				version: num(query.version, 'version'),
				offset: num(query.offset, 'offset', 0),
				limit: num(query.limit, 'limit')
			})
	},
	{
		method: 'POST',
		path: '/orgs/{org}/mockups/{id}/restore',
		summary: 'Restore an earlier version: it is copied on top as the newest one',
		tag: 'Mockups',
		body: z.object({ version: z.number().int().min(1) }),
		handler: ({ ctx, params, body }) =>
			restoreMockupVersion(ctx, params.id, (body as { version: number }).version)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/mockups/{id}/versions/{number}/notes',
		summary: 'Write the Keep and Free build notes of one version',
		tag: 'Mockups',
		body: z.object({
			keepNotes: z.string().max(20_000).optional(),
			freeNotes: z.string().max(20_000).optional()
		}),
		handler: ({ ctx, params, body }) =>
			setVersionNotes(ctx, params.id, num(params.number, 'version number')!, body as never)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/mockups/{id}/versions/{number}/screenshot',
		summary: 'Set the screenshot of one version (a PNG as the body)',
		tag: 'Mockups',
		upload: true,
		handler: ({ ctx, params, bytes }) =>
			setVersionScreenshot(
				ctx,
				params.id,
				num(params.number, 'version number')!,
				bytes ?? new Uint8Array()
			)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/mockups/{id}/link',
		summary: 'Link a mockup to a plan, or unlink it with item null',
		tag: 'Mockups',
		body: z.object({ item: z.string().min(1).nullable() }),
		handler: ({ ctx, params, body }) =>
			linkMockup(ctx, params.id, (body as { item: string | null }).item)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/mockups/{id}/public-link',
		summary:
			'Switch the public link on (a new address, shown once) or off. Admins and owners only.',
		tag: 'Mockups',
		body: z.object({ on: z.boolean() }),
		handler: ({ ctx, params, body }) =>
			setMockupPublicLink(ctx, params.id, (body as { on: boolean }).on)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/mockups/{id}',
		summary: 'Move a mockup to the trash (its public link goes off for good)',
		tag: 'Mockups',
		handler: ({ ctx, params }) => trashMockup(ctx, params.id)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/mockups/{id}/restore-from-trash',
		summary: 'Bring a mockup back from the trash (its public link stays off)',
		tag: 'Mockups',
		handler: ({ ctx, params }) => restoreMockupFromTrash(ctx, params.id)
	},

	// -- pins -- //
	{
		method: 'GET',
		path: '/orgs/{org}/mockups/{id}/pins',
		summary:
			'The pinned comments of a mockup, of one version when version is given (untrusted text)',
		tag: 'Mockups',
		handler: ({ ctx, params, query }) =>
			listMockupPins(ctx, params.id, num(query.version, 'version'))
	},
	{
		method: 'POST',
		path: '/orgs/{org}/mockups/{id}/pins',
		summary: 'Pin a comment to a version of a mockup',
		tag: 'Mockups',
		body: pinInput.omit({ mockup: true }),
		handler: ({ ctx, params, body }) =>
			addMockupPin(ctx, { ...(body as object), mockup: params.id } as never)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/mockup-pins/{id}',
		summary: 'Remove a pin',
		tag: 'Mockups',
		handler: ({ ctx, params }) => removeMockupPin(ctx, params.id)
	},

	// -- project style, templates and kit -- //
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{project}/mockup-settings',
		summary:
			'The mockup style, templates, screens, themes and kit details of a project (untrusted text)',
		tag: 'Mockups',
		handler: ({ ctx, params }) => getMockupSettings(ctx, params.project)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/projects/{project}/mockup-settings',
		summary: 'Save the mockup style, screens and themes. Admins and owners only.',
		tag: 'Mockups',
		body: noProject(styleInput),
		handler: ({ ctx, params, body }) =>
			setMockupStyle(ctx, { ...(body as object), project: params.project } as never)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/projects/{project}/mockup-templates',
		summary: 'Create or change a named page template. Admins and owners only.',
		tag: 'Mockups',
		body: noProject(templateInput),
		handler: ({ ctx, params, body }) =>
			saveMockupTemplate(ctx, { ...(body as object), project: params.project } as never)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/projects/{project}/mockup-templates',
		summary: 'Delete a page template by name (query name). Admins and owners only.',
		tag: 'Mockups',
		handler: ({ ctx, params, query }) => deleteMockupTemplate(ctx, params.project, query.name ?? '')
	},
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{project}/mockup-kit',
		summary: 'The newest project kit as text, or a part of it (untrusted text)',
		tag: 'Mockups',
		handler: ({ ctx, params, query }) =>
			readMockupKit(ctx, params.project, {
				offset: num(query.offset, 'offset', 0),
				limit: num(query.limit, 'limit')
			})
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/projects/{project}/mockup-kit',
		summary:
			'Save a new project kit (the HTML as the body, with the commit it was built from), or send stale=true with no body to mark it out of date. The answer carries warnings about the kit, in plain words. Admins and owners only.',
		tag: 'Mockups',
		query: noProject(kitInput),
		upload: true,
		handler: ({ ctx, params, query, bytes }) =>
			setMockupKit(
				ctx,
				{
					project: params.project,
					builtFromCommit: query.builtFromCommit ?? '',
					summary: query.summary ?? '',
					stale: query.stale === undefined ? undefined : bool(query.stale)
				},
				bytes
			)
	}
];
