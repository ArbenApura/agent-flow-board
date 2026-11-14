// THE MOCKUP ENDPOINTS OF THE REST ROUTE TABLE (AFB-20261107-0346). EACH ONE IS A THIN WRAPPER AROUND AN OPERATIONS VERB
// A published file goes up as the raw body with the plan and title in the query. Notes, screenshot and settings are their own calls,
// so no text has to fit in an address.

// -- TYPES -- //
import type { Route } from './routes';
// -- DEP-MODULES -- //
import { z } from 'zod';
// -- MODULES -- //
import { OpError } from '../ops/context';
import {
	addMockupPin,
	listMockupPins,
	pinInput,
	removeMockupPin,
	setMockupPinResolved
} from '../ops/mockupPins';
import {
	bundleInput,
	getMockupContract,
	getMockupInventory,
	listMockupParts,
	publishMockupBundle,
	readMockupPart,
	readProjectShell,
	setProjectShell
} from '../ops/mockupParts';
import { recordMockupRead } from '../ops/mockupReads';
import { kitInput, readMockupKit, setMockupKit } from '../ops/mockupSettings';
import {
	getMockup,
	linkMockup,
	listMockups,
	mintMockupUrl,
	mintMockupUrlInput,
	publishInput,
	publishMockup,
	readMockupHtml,
	restoreMockupFromTrash,
	restoreMockupVersion,
	setMockupPublicLink,
	renderInput,
	setVersionNotes,
	setVersionRender,
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
		method: 'POST',
		path: '/orgs/{org}/mockups/{id}/url',
		summary: 'Mint a short-lived signed mockup URL for inspection or visual checks',
		tag: 'Mockups',
		body: mintMockupUrlInput,
		handler: ({ ctx, params, body }) =>
			mintMockupUrl(ctx, params.id, (body ?? {}) as z.input<typeof mintMockupUrlInput>)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/mockups/{id}/html',
		summary: 'The HTML of one version, or a part of it (untrusted text)',
		tag: 'Mockups',
		handler: async ({ ctx, params, query }) => {
			const part = await readMockupHtml(ctx, params.id, {
				version: num(query.version, 'version'),
				offset: num(query.offset, 'offset', 0),
				limit: num(query.limit, 'limit')
			});
			// A tool with no mockup_get reads here. With its session id the part counts as read (AFB-20261110-2331)
			if (!query.sessionId) return part;
			const read = await recordMockupRead(ctx, {
				mockup: params.id,
				version: part.version,
				offset: part.offset,
				served: part.html.length,
				length: part.length,
				sessionId: query.sessionId
			});
			return {
				...part,
				nextOffset: part.more ? part.offset + part.html.length : null,
				recorded: read.recorded,
				...(read.recorded ? { readChars: read.readChars, unreadChars: read.unreadChars } : {})
			};
		}
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
		method: 'PUT',
		path: '/orgs/{org}/mockups/{id}/versions/{number}/renders',
		summary:
			'Save what a browser saw of one screen, state and width of a version: a picture (pngBase64), the rendered element tree (elements) and its advisory quality findings (checks). The same screen, state and width replaces the earlier render',
		tag: 'Mockups',
		body: renderInput,
		handler: ({ ctx, params, body }) =>
			setVersionRender(ctx, params.id, num(params.number, 'version number')!, body as never)
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
		method: 'POST',
		path: '/orgs/{org}/mockup-pins/{id}/resolve',
		summary:
			'Mark a pin done (resolved true) or open again (resolved false). Anyone who can write.',
		tag: 'Mockups',
		body: z.object({ resolved: z.boolean() }),
		handler: ({ ctx, params, body }) =>
			setMockupPinResolved(ctx, params.id, (body as { resolved: boolean }).resolved)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/mockup-pins/{id}',
		summary: 'Remove a pin',
		tag: 'Mockups',
		handler: ({ ctx, params }) => removeMockupPin(ctx, params.id)
	},

	// -- project kit -- //
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
	},

	// -- parts, contract and the project shell (AFB-20261114-0409) -- //
	{
		method: 'POST',
		path: '/orgs/{org}/mockups/bundle',
		summary:
			'Publish a mockup made of parts (a skeleton or the project shell, screens, sheets, styles, motion, behaviour, fixtures and a contract). The server composes the page and keeps the parts. Name the plan with item, or a project, or an existing mockup for a new version. The answer carries the same warnings and readCost as a single file',
		tag: 'Mockups',
		body: bundleInput,
		handler: ({ ctx, body }) => publishMockupBundle(ctx, body as never)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/mockups/{id}/parts',
		summary: 'The parts of a version in the order they were pushed (empty for a single file)',
		tag: 'Mockups',
		handler: ({ ctx, params, query }) =>
			listMockupParts(ctx, params.id, { version: num(query.version, 'version') })
	},
	{
		method: 'GET',
		path: '/orgs/{org}/mockups/{id}/parts/{kind}/{key}',
		summary: 'The text of one part of a version, or a piece of it (untrusted text)',
		tag: 'Mockups',
		handler: ({ ctx, params, query }) =>
			readMockupPart(ctx, params.id, {
				version: num(query.version, 'version'),
				kind: params.kind,
				key: params.key,
				offset: num(query.offset, 'offset', 0),
				limit: num(query.limit, 'limit')
			})
	},
	{
		method: 'GET',
		path: '/orgs/{org}/mockups/{id}/inventory',
		summary:
			'The Mockup inventory of some screens or sheets (scopes, comma separated, for example today,surface:lab), seeded from the source: regions, texts, states, what opens what, and every transition and animation. Mark each line built, free or differs in the design brief',
		tag: 'Mockups',
		handler: ({ ctx, params, query }) =>
			getMockupInventory(ctx, params.id, {
				version: num(query.version, 'version'),
				scopes: (query.scopes ?? '')
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			})
	},
	{
		method: 'GET',
		path: '/orgs/{org}/mockups/{id}/contract',
		summary:
			'The contract of a version (bound, keep and free regions, the app pairing, widths and states), or null when it has none',
		tag: 'Mockups',
		handler: ({ ctx, params, query }) =>
			getMockupContract(ctx, params.id, { version: num(query.version, 'version') })
	},
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{project}/mockup-shell',
		summary: 'The newest project shell as text, or null when none was saved (untrusted text)',
		tag: 'Mockups',
		handler: ({ ctx, params }) => readProjectShell(ctx, params.project)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/projects/{project}/mockup-shell',
		summary:
			"Save the project shell: the app's root layout as the body, with <!--afb-part:screens--> where the screens go (and optional slots for head, styles, surfaces, fixtures and behaviour). A bundle that sends no skeleton uses it",
		tag: 'Mockups',
		upload: true,
		handler: ({ ctx, params, bytes }) =>
			setProjectShell(ctx, { project: params.project }, bytes ?? new Uint8Array())
	}
];
