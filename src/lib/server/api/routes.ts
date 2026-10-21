// THE REST ROUTE TABLE. ONE ENTRY PER ENDPOINT, EACH A THIN WRAPPER AROUND AN OPERATIONS VERB (ADR-002)
// The dispatcher validates input with the entry's Zod schema, builds the context from the caller's live role, and calls the verb.
// The OpenAPI document is generated from this same table, so the docs cannot drift from the code.

// -- TYPES -- //
import { searchBoard } from '../ops/board';
import { relatedPlans } from '../ops/related';
import type { Ctx } from '../ops/context';
// -- DEP-MODULES -- //
import { z } from 'zod';
// -- MODULES -- //
import {
	addComment,
	commentInput,
	createTask,
	decisionInput,
	deleteDecision,
	deleteTask,
	listComments,
	listTasks,
	restoreTask,
	sectionInput,
	taskDeleteInput,
	taskInput,
	taskUpdateInput,
	updateTask,
	upsertDecision,
	upsertSection
} from '../ops/docs';
import {
	attachInput,
	addAttachment,
	attachmentLink,
	deleteAttachment,
	restoreAttachment,
	listAttachments,
	setAttachmentVisibility
} from '../ops/attachments';
import {
	eventsInput,
	listEvents,
	listTrash,
	purgeTrash,
	undoChange,
	undoSession
} from '../ops/history';
import {
	createItem,
	createItemInput,
	getItem,
	listItems,
	listItemsInput,
	restoreItem,
	trashItem,
	updateItem,
	updateItemInput
} from '../ops/items';
import { pinProject, unpinProject } from '../ops/pins';
import {
	createProject,
	getProject,
	listProjects,
	projectInput,
	projectUpdateInput,
	updateProject
} from '../ops/projects';
import {
	addChecksInput,
	addManualChecks,
	addPhase,
	addPhaseInput,
	addSteps,
	addStepsInput,
	updateStep,
	updateStepBody
} from '../ops/plan';
import { recordInput, recordSteps } from '../ops/steps';
import { setStatus, setStatusInput } from '../ops/status';
import { createToken, listTokens, revokeToken, tokenInput } from '../ops/tokens';
import { OpError, requireCap, run } from '../ops/context';
import { sql } from 'drizzle-orm';
import { project } from '../db/schema';
import { clearProjectLogo, setProjectLogo } from '../ops/pictures';
import {
	auditInput,
	clearOrgLogo,
	emailStatus,
	getOrgSettings,
	orgAuditLog,
	orgBackups,
	orgSettingsInput,
	setOrgLogo,
	updateOrgSettings
} from '../ops/settings';
import {
	checkInput,
	deleteCheck,
	itemChecks,
	listRuns,
	requestRun,
	requestRunInput,
	saveCheck
} from '../ops/checks';
import {
	accountInput,
	createRunner,
	deleteAccount,
	deleteEnvironment,
	deleteRunner,
	environmentFields,
	listAccounts,
	listEnvironments,
	approveToolConnection,
	listRunners,
	registerToolRunner,
	runnerInput,
	saveAccount,
	saveEnvironment,
	setRunnerProjects,
	toolApprovalInput,
	toolRunnerInput
} from '../ops/environments';
import {
	getScale,
	itemShots,
	listUiChanges,
	requestMeasure,
	requestShots,
	requestShotsInput,
	saveUiChanges
} from '../ops/uiShots';
import { backupHealth } from '../backup/run';
import { handleHook, hookInput } from '../ops/hooks';
import { createInvite, listInvites, revokeInvite } from '../orgs/invites';
import {
	changeRole,
	deleteOrg,
	listMembers,
	orgDeletionSummary,
	removeMember,
	setProjectRole
} from '../orgs/orgs';

// -- TYPES -- //

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type Handler = (a: {
	ctx: Ctx;
	params: Record<string, string>;
	body: unknown;
	query: Record<string, string>;
	bytes?: Uint8Array;
}) => Promise<unknown>;
export type Route = {
	method: Method;
	/** Relative to /api/v1. `{org}` at the start means the route runs inside that org. */
	path: string;
	summary: string;
	tag: string;
	body?: z.ZodType;
	query?: z.ZodType;
	/** Raw bytes in the body (an upload). The other fields arrive in the query. */
	upload?: boolean;
	/** Tokens may not call this (a token cannot mint tokens). */
	sessionOnly?: boolean;
	handler: Handler;
};

// -- CONSTANTS -- //

const strip = <T extends z.ZodRawShape>(shape: z.ZodObject<T>, ...keys: (keyof T)[]) =>
	shape.omit(Object.fromEntries(keys.map((k) => [k, true])) as never);
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

// -- FUNCTIONS -- //

/** The route table. */
export const routes: Route[] = [
	// -- projects -- //
	{
		method: 'GET',
		path: '/orgs/{org}/projects',
		summary: 'List the projects you can see',
		tag: 'Projects',
		handler: ({ ctx }) => listProjects(ctx)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/projects',
		summary: 'Create a project (admins and owners)',
		tag: 'Projects',
		body: projectInput,
		handler: ({ ctx, body }) => createProject(ctx, body as never)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{project}',
		summary: 'Read one project and its settings',
		tag: 'Projects',
		handler: ({ ctx, params }) => getProject(ctx, params.project)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/projects/{project}/pin',
		summary: 'Pin a project to the top of your own project list',
		tag: 'Projects',
		handler: ({ ctx, params }) => pinProject(ctx, params.project)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/projects/{project}/pin',
		summary: 'Remove your pin from a project',
		tag: 'Projects',
		handler: ({ ctx, params }) => unpinProject(ctx, params.project)
	},
	{
		method: 'PATCH',
		path: '/orgs/{org}/projects/{project}',
		summary: 'Change project settings',
		tag: 'Projects',
		body: strip(projectUpdateInput, 'project'),
		handler: ({ ctx, params, body }) =>
			updateProject(ctx, { ...(body as object), project: params.project })
	},

	// -- items -- //
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{project}/items',
		summary: 'List items of a project, by keyset',
		tag: 'Items',
		query: strip(listItemsInput, 'project'),
		handler: ({ ctx, params, query }) =>
			listItems(ctx, {
				project: params.project,
				status: query.status ? (query.status.split(',') as never) : undefined,
				stream: query.stream || undefined,
				scope: query.scope || undefined,
				q: query.q || undefined,
				cursor: num(query.cursor),
				order: (query.order as 'asc' | 'desc' | undefined) ?? 'desc',
				sort: query.sort === 'activity' ? 'activity' : 'number',
				limit: num(query.limit) ?? 50,
				trashed: query.trashed === 'true'
			})
	},
	{
		method: 'POST',
		path: '/orgs/{org}/projects/{project}/items',
		summary: 'Create an item with its plan',
		tag: 'Items',
		body: strip(createItemInput, 'project'),
		handler: ({ ctx, params, body }) =>
			createItem(ctx, { ...(body as object), project: params.project } as never)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/items/{item}',
		summary:
			'Read an item with phases, steps, checks, decisions and sections. The name may be an id, a reference or an old alias.',
		tag: 'Items',
		handler: ({ ctx, params }) => getItem(ctx, params.item)
	},
	{
		method: 'PATCH',
		path: '/orgs/{org}/items/{item}',
		summary: 'Change item fields',
		tag: 'Items',
		body: strip(updateItemInput, 'item'),
		handler: ({ ctx, params, body }) => updateItem(ctx, { ...(body as object), item: params.item })
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/items/{item}',
		summary: 'Move an item to the trash for 30 days',
		tag: 'Items',
		// A REST DELETE names the item outright, so the call is its own confirmation
		handler: ({ ctx, params }) => trashItem(ctx, params.item, undefined, true)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{item}/restore',
		summary: 'Restore an item from the trash',
		tag: 'Items',
		handler: ({ ctx, params }) => restoreItem(ctx, params.item)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{item}/phases',
		summary: 'Add a phase (with steps) to the plan',
		tag: 'Plan',
		body: strip(addPhaseInput, 'item'),
		handler: ({ ctx, params, body }) =>
			addPhase(ctx, { ...(body as object), item: params.item } as never)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{item}/steps',
		summary: 'Add steps to a phase',
		tag: 'Plan',
		body: strip(addStepsInput, 'item'),
		handler: ({ ctx, params, body }) =>
			addSteps(ctx, { ...(body as object), item: params.item } as never)
	},
	{
		method: 'PATCH',
		path: '/orgs/{org}/items/{item}/steps/{key}',
		summary: 'Change the wording of an open step, or remove it from the plan',
		tag: 'Plan',
		body: strip(updateStepBody, 'item', 'key'),
		handler: ({ ctx, params, body }) =>
			updateStep(ctx, { ...(body as object), item: params.item, key: params.key } as never)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{item}/checks',
		summary: 'Add manual checks (never counted toward the percent)',
		tag: 'Plan',
		body: strip(addChecksInput, 'item'),
		handler: ({ ctx, params, body }) =>
			addManualChecks(ctx, { ...(body as object), item: params.item } as never)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{item}/record',
		summary: 'Mark steps and checks. Moves the status automatically and returns the next steps.',
		tag: 'Progress',
		body: strip(recordInput, 'item'),
		handler: ({ ctx, params, body }) => recordSteps(ctx, { ...(body as object), item: params.item })
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{item}/status',
		summary: 'Set a status. COMPLETED needs every step closed and may be kept for people.',
		tag: 'Progress',
		body: strip(setStatusInput, 'item'),
		handler: ({ ctx, params, body }) =>
			setStatus(ctx, { ...(body as object), item: params.item } as never)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{item}/decisions',
		summary: 'Create or update a decision (adr) or a settled question',
		tag: 'Documents',
		body: strip(decisionInput, 'item'),
		handler: ({ ctx, params, body }) =>
			upsertDecision(ctx, { ...(body as object), item: params.item } as never)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/decisions/{id}',
		summary: 'Delete a decision',
		tag: 'Documents',
		handler: ({ ctx, params }) => deleteDecision(ctx, params.id)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/items/{item}/sections/{slug}',
		summary: 'Create or replace a document section',
		tag: 'Documents',
		body: strip(sectionInput, 'item', 'slug'),
		handler: ({ ctx, params, body }) =>
			upsertSection(ctx, { ...(body as object), item: params.item, slug: params.slug } as never)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/items/{item}/comments',
		summary: 'List comments',
		tag: 'Documents',
		handler: ({ ctx, params }) => listComments(ctx, params.item)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{item}/comments',
		summary: 'Add a comment. A guest comment is marked untrusted.',
		tag: 'Documents',
		body: strip(commentInput, 'item'),
		handler: ({ ctx, params, body }) =>
			addComment(ctx, { ...(body as object), item: params.item } as never)
	},

	// -- tasks -- //
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{project}/tasks',
		summary: 'List tasks',
		tag: 'Tasks',
		handler: ({ ctx, params }) => listTasks(ctx, params.project)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/projects/{project}/tasks',
		summary: 'Create a task',
		tag: 'Tasks',
		body: strip(taskInput, 'project'),
		handler: ({ ctx, params, body }) =>
			createTask(ctx, { ...(body as object), project: params.project } as never)
	},
	{
		method: 'PATCH',
		path: '/orgs/{org}/tasks/{id}',
		summary: 'Change a task',
		tag: 'Tasks',
		body: strip(taskUpdateInput, 'task'),
		handler: ({ ctx, params, body }) =>
			updateTask(ctx, { ...(body as object), task: params.id } as never)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/tasks/{id}',
		summary: 'Move a task to the trash for 30 days',
		tag: 'Tasks',
		query: strip(taskDeleteInput, 'task'),
		handler: ({ ctx, params, query }) =>
			deleteTask(ctx, { task: params.id, expectVersion: num(query.expectVersion) })
	},
	{
		method: 'POST',
		path: '/orgs/{org}/tasks/{id}/restore',
		summary: 'Restore a task from the trash',
		tag: 'Tasks',
		handler: ({ ctx, params }) => restoreTask(ctx, params.id)
	},

	// -- attachments -- //
	{
		method: 'GET',
		path: '/orgs/{org}/items/{item}/attachments',
		summary: 'List attachments you may see',
		tag: 'Attachments',
		handler: ({ ctx, params }) => listAttachments(ctx, params.item)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{item}/attachments',
		summary:
			'Attach a file. Send the bytes as the body, the name and caption in the query. Private by default.',
		tag: 'Attachments',
		query: strip(attachInput, 'item'),
		upload: true,
		handler: ({ ctx, params, query, bytes }) =>
			addAttachment(
				ctx,
				{
					item: params.item,
					filename: query.filename ?? '',
					caption: query.caption ?? '',
					kind: query.kind ?? 'file',
					visibility: (query.visibility as 'public' | 'private' | undefined) ?? 'private',
					refs: query.refs ? query.refs.split(',') : []
				},
				bytes ?? new Uint8Array()
			)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/attachments/{id}/link',
		summary: 'A link to the file that works for 5 minutes',
		tag: 'Attachments',
		handler: ({ ctx, params }) => attachmentLink(ctx, params.id)
	},
	{
		method: 'PATCH',
		path: '/orgs/{org}/attachments/{id}',
		summary: 'Make an attachment public or private',
		tag: 'Attachments',
		body: z.object({ visibility: z.enum(['public', 'private']) }),
		handler: ({ ctx, params, body }) =>
			setAttachmentVisibility(
				ctx,
				params.id,
				(body as { visibility: 'public' | 'private' }).visibility
			)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/attachments/{id}',
		summary: 'Move an attachment to the trash',
		tag: 'Attachments',
		handler: ({ ctx, params }) => deleteAttachment(ctx, params.id)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/attachments/{id}/restore',
		summary: 'Bring a file back from the trash',
		tag: 'Attachments',
		handler: ({ ctx, params }) => restoreAttachment(ctx, params.id)
	},

	// -- activity, undo and trash -- //
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{project}/events',
		summary: 'The activity log, each event labelled undoable, final, external or undone',
		tag: 'Activity',
		query: strip(eventsInput, 'project'),
		handler: ({ ctx, params, query }) =>
			listEvents(ctx, {
				project: params.project,
				item: query.item,
				sessionId: query.sessionId,
				afterId: num(query.afterId),
				limit: num(query.limit) ?? 50
			})
	},
	{
		method: 'POST',
		path: '/orgs/{org}/events/{id}/undo',
		summary: 'Undo one change with a compensating event',
		tag: 'Activity',
		body: z.object({ force: z.boolean().optional() }).optional(),
		handler: ({ ctx, params, body }) =>
			undoChange(ctx, Number(params.id), {
				force: (body as { force?: boolean } | undefined)?.force
			})
	},
	{
		method: 'POST',
		path: '/orgs/{org}/sessions/{id}/undo',
		summary: 'Undo everything one session changed, newest first',
		tag: 'Activity',
		handler: ({ ctx, params }) => undoSession(ctx, params.id)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{project}/trash',
		summary: 'What is in the trash and how long it stays',
		tag: 'Activity',
		handler: ({ ctx, params }) => listTrash(ctx, params.project)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/trash/purge',
		summary: 'Remove trash older than 30 days for good (admins)',
		tag: 'Activity',
		handler: ({ ctx }) => purgeTrash(ctx)
	},

	// -- organisation settings -- //
	{
		method: 'GET',
		path: '/orgs/{org}/settings',
		summary: 'The organisation name, palette, logo and limits',
		tag: 'Settings',
		handler: ({ ctx }) => getOrgSettings(ctx)
	},
	{
		method: 'PATCH',
		path: '/orgs/{org}/settings',
		summary:
			'Change the name, the accent palette or the limits (admins and owners). Only what is sent changes.',
		tag: 'Settings',
		sessionOnly: true,
		body: orgSettingsInput,
		handler: ({ ctx, body }) => updateOrgSettings(ctx, body as never)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/logo',
		summary:
			'Set the logo. Send the picture bytes as the body with its type in the content type (PNG, JPEG or WebP, 200 KB at most).',
		tag: 'Settings',
		sessionOnly: true,
		upload: true,
		query: z.object({ type: z.string() }),
		handler: ({ ctx, query, bytes }) => setOrgLogo(ctx, bytes ?? new Uint8Array(), query.type ?? '')
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/logo',
		summary: 'Remove the logo',
		tag: 'Settings',
		sessionOnly: true,
		handler: ({ ctx }) => clearOrgLogo(ctx)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/projects/{project}/logo',
		summary:
			'Set the logo of a project (needs the manage right on it). Send the picture bytes as the body with its type in the query (PNG, JPEG or WebP, 200 KB at most).',
		tag: 'Projects',
		sessionOnly: true,
		upload: true,
		query: z.object({ type: z.string() }),
		handler: ({ ctx, params, query, bytes }) =>
			setProjectLogo(ctx, params.project, bytes ?? new Uint8Array(), query.type ?? '')
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/projects/{project}/logo',
		summary: 'Remove the logo of a project',
		tag: 'Projects',
		sessionOnly: true,
		handler: ({ ctx, params }) => clearProjectLogo(ctx, params.project)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/audit',
		summary: 'The audit log of the whole organisation (admins and owners)',
		tag: 'Settings',
		query: auditInput,
		handler: ({ ctx, query }) =>
			orgAuditLog(ctx, {
				project: query.project || undefined,
				before: num(query.before),
				limit: num(query.limit) ?? 50
			})
	},
	{
		method: 'GET',
		path: '/orgs/{org}/backups',
		summary: 'Whether backups are on, the newest result and the recent runs (admins and owners)',
		tag: 'Settings',
		handler: ({ ctx }) => orgBackups(ctx)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/email',
		summary: 'How this server sends email',
		tag: 'Settings',
		handler: async ({ ctx }) => emailStatus(ctx)
	},

	// -- tool hooks -- //
	{
		method: 'POST',
		path: '/orgs/{org}/hooks',
		summary:
			'One hook event of a coding tool (brief, title, heartbeat, close question, stop reminder). The bridge adapters call this.',
		tag: 'Hooks',
		body: hookInput,
		handler: ({ ctx, body }) => handleHook(ctx, body as never)
	},

	// -- backups -- //
	{
		method: 'GET',
		path: '/orgs/{org}/backup-health',
		summary:
			'Whether the newest backup of this organisation is recent and good (admins and owners)',
		tag: 'Backups',
		handler: async ({ ctx }) => {
			await run(ctx, (tx) => requireCap(tx, ctx, 'manage'));
			return backupHealth(ctx.handle, ctx.orgId);
		}
	},

	// -- search -- //
	{
		method: 'GET',
		path: '/orgs/{org}/search',
		summary: 'Search items, sections, decisions and tasks',
		tag: 'Search',
		query: z.object({ q: z.string().min(1), limit: z.number().optional() }),
		handler: ({ ctx, query }) => searchBoard(ctx, query.q ?? '', { limit: num(query.limit) })
	},

	{
		method: 'GET',
		path: '/orgs/{org}/related-plans',
		summary: 'The closest earlier plans to an idea, as short digests',
		tag: 'Search',
		query: z.object({
			q: z.string().min(1).max(500),
			project: z.string().optional(),
			files: z.string().max(1000).optional(),
			stream: z.string().max(40).optional(),
			scope: z.string().max(40).optional(),
			limit: z.number().optional()
		}),
		handler: ({ ctx, query }) =>
			relatedPlans(ctx, {
				q: query.q,
				project: query.project,
				// Files come as one comma separated list in a query string
				files: query.files
					?.split(',')
					.map((f) => f.trim())
					.filter(Boolean)
					.slice(0, 8),
				stream: query.stream,
				scope: query.scope,
				limit: num(query.limit)
			})
	},

	// -- members and invites (people only: org level actions stay in the web app, ADR-006) -- //
	{
		method: 'GET',
		path: '/orgs/{org}/members',
		summary: 'List the members of the organisation',
		tag: 'Members',
		sessionOnly: true,
		handler: ({ ctx }) => listMembers(ctx.handle, ctx.orgId)
	},
	{
		method: 'PATCH',
		path: '/orgs/{org}/members/{userId}',
		summary: 'Change a member role (owners, and admins below admin)',
		tag: 'Members',
		sessionOnly: true,
		body: z.object({ role: z.enum(['owner', 'admin', 'member', 'viewer', 'guest']) }),
		handler: ({ ctx, params, body }) =>
			changeRole(
				ctx.handle,
				ctx.orgId,
				ctx.actor.userId,
				params.userId,
				(body as { role: 'owner' | 'admin' | 'member' | 'viewer' | 'guest' }).role
			)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/members/{userId}',
		summary: 'Remove a member. Their tokens stop at once.',
		tag: 'Members',
		sessionOnly: true,
		handler: ({ ctx, params }) =>
			removeMember(ctx.handle, ctx.orgId, ctx.actor.userId, params.userId)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/deletion',
		summary: 'What deleting the organisation would remove (owners only)',
		tag: 'Members',
		sessionOnly: true,
		handler: ({ ctx }) => orgDeletionSummary(ctx.handle, ctx.orgId, ctx.actor.userId)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/delete',
		summary:
			'Delete the organisation (owners only). It is locked at once and erased after the grace period unless an owner restores it. Restoring is done on the web page of the locked organisation.',
		tag: 'Members',
		sessionOnly: true,
		body: z.object({ name: z.string().max(200) }),
		handler: ({ ctx, body }) =>
			deleteOrg(ctx.handle, ctx.orgId, ctx.actor.userId, (body as { name: string }).name)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/projects/{project}/members/{userId}',
		summary: 'Set or clear (role null) a per project role override',
		tag: 'Members',
		sessionOnly: true,
		body: z.object({ role: z.enum(['owner', 'admin', 'member', 'viewer', 'guest']).nullable() }),
		handler: ({ ctx, params, body }) =>
			run(
				ctx,
				async (tx) =>
					(
						await tx
							.select({ id: project.id })
							.from(project)
							.where(
								sql`upper(${project.key}) = ${params.project.toUpperCase()} and ${project.orgId} = ${ctx.orgId}`
							)
					)[0]?.id
			).then((pid) => {
				if (!pid) throw new OpError('NOT_FOUND', 'That project does not exist.');
				return setProjectRole(
					ctx.handle,
					ctx.orgId,
					ctx.actor.userId,
					pid,
					params.userId,
					(body as { role: 'owner' | 'admin' | 'member' | 'viewer' | 'guest' | null }).role
				);
			})
	},
	{
		method: 'GET',
		path: '/orgs/{org}/invites',
		summary: 'Open invitations',
		tag: 'Members',
		sessionOnly: true,
		handler: ({ ctx }) => listInvites(ctx.handle, ctx.orgId, ctx.actor.userId)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/invites',
		summary:
			'Invite one email address at a role. The link is mailed once and bound to that address.',
		tag: 'Members',
		sessionOnly: true,
		body: z.object({
			email: z.string().min(3),
			role: z.enum(['owner', 'admin', 'member', 'viewer', 'guest'])
		}),
		handler: ({ ctx, body }) => {
			if (!ctx.services?.mailer || !ctx.services.baseUrl)
				throw new OpError('INVALID', 'Email is not configured on this server.');
			return createInvite(
				ctx.handle,
				ctx.services.mailer,
				ctx.services.baseUrl,
				ctx.orgId,
				ctx.actor.userId,
				body as { email: string; role: 'owner' | 'admin' | 'member' | 'viewer' | 'guest' }
			);
		}
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/invites/{id}',
		summary: 'Withdraw an invitation',
		tag: 'Members',
		sessionOnly: true,
		handler: ({ ctx, params }) => revokeInvite(ctx.handle, ctx.orgId, ctx.actor.userId, params.id)
	},

	// -- environments, test accounts and runners (browser checks and UI shots, SPEC 10) -- //
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{project}/environments',
		summary: 'The environments browser checks and UI shots can run against',
		tag: 'Browser checks',
		handler: ({ ctx, params }) => listEnvironments(ctx, params.project)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/projects/{project}/environments',
		summary: 'Add an environment, or change the one with the same name (admins and owners)',
		tag: 'Browser checks',
		body: strip(environmentFields, 'project'),
		handler: ({ ctx, params, body }) =>
			saveEnvironment(ctx, { ...(body as object), project: params.project } as never)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/projects/{project}/environments/{name}',
		summary: 'Remove an environment',
		tag: 'Browser checks',
		handler: ({ ctx, params }) => deleteEnvironment(ctx, params.project, params.name)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{project}/accounts',
		summary: 'The names of the test accounts runs sign in with. Never their passwords.',
		tag: 'Browser checks',
		handler: ({ ctx, params }) => listAccounts(ctx, params.project)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/projects/{project}/accounts',
		summary: 'Save a test account, sealed. Only a signed in admin or owner.',
		tag: 'Browser checks',
		sessionOnly: true,
		body: strip(accountInput, 'project'),
		handler: ({ ctx, params, body }) =>
			saveAccount(ctx, { ...(body as object), project: params.project } as never)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/projects/{project}/accounts/{name}',
		summary: 'Remove a test account',
		tag: 'Browser checks',
		sessionOnly: true,
		handler: ({ ctx, params }) => deleteAccount(ctx, params.project, params.name)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/runners',
		summary: 'The runners of the organisation and which are online',
		tag: 'Browser checks',
		handler: ({ ctx }) => listRunners(ctx)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/runners',
		summary: 'Register a runner. Its token is shown once.',
		tag: 'Browser checks',
		sessionOnly: true,
		body: runnerInput,
		handler: ({ ctx, body }) => createRunner(ctx, body as never)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/runners/tool',
		summary:
			'Register the afb-checks tool as a runner. A personal token that may manage is enough. Its runner token is shown once.',
		tag: 'Browser checks',
		body: toolRunnerInput,
		handler: ({ ctx, body }) => registerToolRunner(ctx, body as never)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/runners/tool/approve',
		summary:
			'Approve the sign in code of the afb-checks tool that printed it, with the verifier it printed. The caller must hold the manage permission.',
		tag: 'Browser checks',
		body: toolApprovalInput,
		handler: ({ ctx, body }) => approveToolConnection(ctx, body as never)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/runners/{id}/projects',
		summary: 'Choose the projects a runner serves',
		tag: 'Browser checks',
		sessionOnly: true,
		body: z.object({ projects: z.array(z.string().min(1)).max(50) }),
		handler: ({ ctx, params, body }) =>
			setRunnerProjects(ctx, params.id, (body as { projects: string[] }).projects)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/runners/{id}',
		summary: 'Remove a runner. Its token stops working at once.',
		tag: 'Browser checks',
		sessionOnly: true,
		handler: ({ ctx, params }) => deleteRunner(ctx, params.id)
	},

	// -- browser checks -- //
	{
		method: 'GET',
		path: '/orgs/{org}/items/{item}/browser-checks',
		summary: 'The browser checks of an item, their newest runs and which targets can run now',
		tag: 'Browser checks',
		handler: ({ ctx, params }) => itemChecks(ctx, params.item)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/items/{item}/browser-checks',
		summary: 'Save the browser check of one manual check',
		tag: 'Browser checks',
		body: strip(checkInput, 'item'),
		handler: ({ ctx, params, body }) =>
			saveCheck(ctx, { ...(body as object), item: params.item } as never)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/items/{item}/browser-checks/{key}',
		summary: 'Remove the browser check of a manual check',
		tag: 'Browser checks',
		handler: ({ ctx, params }) => deleteCheck(ctx, params.item, params.key)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{item}/browser-checks/runs',
		summary:
			'Ask for a run. An unavailable target is reported with the targets that can run, never swapped.',
		tag: 'Browser checks',
		body: strip(requestRunInput, 'item'),
		handler: ({ ctx, params, body }) =>
			requestRun(ctx, { ...(body as object), item: params.item } as never)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/items/{item}/browser-checks/runs',
		summary: 'The newest runs of an item',
		tag: 'Browser checks',
		handler: ({ ctx, params }) => listRuns(ctx, { item: params.item })
	},

	// -- UI shots -- //
	{
		method: 'GET',
		path: '/orgs/{org}/items/{item}/ui-changes',
		summary: 'The "UI changes" table of an item',
		tag: 'UI shots',
		handler: ({ ctx, params }) => listUiChanges(ctx, params.item)
	},
	{
		method: 'PUT',
		path: '/orgs/{org}/items/{item}/ui-changes',
		summary: 'Replace the "UI changes" table, as Markdown or as rows. Every row is checked first.',
		tag: 'UI shots',
		body: z.object({
			markdown: z.string().max(200000).optional(),
			rows: z.array(z.any()).optional()
		}),
		handler: ({ ctx, params, body }) =>
			saveUiChanges(ctx, { ...(body as object), item: params.item } as never)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/items/{item}/ui-shots',
		summary: 'The newest UI shots runs of an item, with measurements and flags',
		tag: 'UI shots',
		handler: ({ ctx, params }) => itemShots(ctx, params.item)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/items/{item}/ui-shots',
		summary: 'Ask for a UI shots run. It only reads: every write the page tries is aborted.',
		tag: 'UI shots',
		body: strip(requestShotsInput, 'item'),
		handler: ({ ctx, params, body }) =>
			requestShots(ctx, { ...(body as object), item: params.item } as never)
	},
	{
		method: 'GET',
		path: '/orgs/{org}/projects/{project}/scale',
		summary: 'The measured design scale of the project',
		tag: 'UI shots',
		handler: ({ ctx, params }) => getScale(ctx, params.project)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/projects/{project}/scale/measure',
		summary: 'Measure the design scale from the reference pages (admins and owners)',
		tag: 'UI shots',
		handler: ({ ctx, params }) => requestMeasure(ctx, params.project)
	},

	// -- tokens (a person signed in on the web, never a token) -- //
	{
		method: 'GET',
		path: '/orgs/{org}/tokens',
		summary: 'Your personal access tokens (never the secret)',
		tag: 'Tokens',
		sessionOnly: true,
		handler: ({ ctx }) => listTokens(ctx)
	},
	{
		method: 'POST',
		path: '/orgs/{org}/tokens',
		summary: 'Create a token. The secret is shown once.',
		tag: 'Tokens',
		sessionOnly: true,
		body: tokenInput,
		handler: ({ ctx, body }) => createToken(ctx, body as never)
	},
	{
		method: 'DELETE',
		path: '/orgs/{org}/tokens/{id}',
		summary: 'Revoke a token at once',
		tag: 'Tokens',
		sessionOnly: true,
		handler: ({ ctx, params }) => revokeToken(ctx, params.id)
	}
];

/** Turns `/orgs/{org}/items/{item}` into a matcher that returns the named parts. */
export function compile(path: string): RegExp {
	return new RegExp('^' + path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)') + '/?$');
}

const compiled = routes.map((r) => ({ route: r, re: compile(r.path) }));

/** Finds the route for a method and path, or says which methods the path does allow. */
export function match(
	method: string,
	path: string
): { route: Route; params: Record<string, string> } | { allowed: Method[] } | null {
	const allowed: Method[] = [];
	for (const { route, re } of compiled) {
		const m = re.exec(path);
		if (!m) continue;
		if (route.method === method)
			return {
				route,
				params: Object.fromEntries(
					Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])
				)
			};
		allowed.push(route.method);
	}
	return allowed.length ? { allowed } : null;
}
