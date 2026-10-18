// PROJECT VERBS: LIST, CREATE, READ AND SETTINGS (SPEC 5)

// -- TYPES -- //
import type { Ctx } from './context';
// -- DEP-MODULES -- //
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
// -- MODULES -- //
import { appendEvent } from '../db/events';
import {
	member,
	project,
	projectCols,
	projectCounter,
	projectLogoV,
	projectMember
} from '../db/schema';
import { OpError, projectAllowed, requireCap, run } from './context';
import { actorFields, checkVersion } from './items';
import { findProject } from './resolve';
import { effectiveProjectRole } from '../orgs/roles';

// -- CONSTANTS -- //

export const projectInput = z.object({
	key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, 'A project key is 2 to 10 capitals or digits'),
	name: z.string().min(2).max(80),
	webApp: z.boolean().default(false),
	streams: z
		.array(
			z.object({
				stream: z.string().min(1).max(40),
				scopes: z.array(z.string().min(1).max(40)).max(20)
			})
		)
		.max(20)
		.default([])
});

export const projectUpdateInput = z.object({
	project: z.string().min(1),
	expectVersion: z.number().int().optional(),
	name: z.string().min(2).max(80).optional(),
	webApp: z.boolean().optional(),
	rules: z.string().max(100_000).optional(),
	streams: z
		.array(
			z.object({
				stream: z.string().min(1).max(40),
				scopes: z.array(z.string().min(1).max(40)).max(20)
			})
		)
		.max(20)
		.optional(),
	themes: z
		.array(z.object({ key: z.string().min(1).max(30), label: z.string().min(1).max(40) }))
		.max(8)
		.optional(),
	/** ADR-027: when off, an agent's COMPLETED is refused and people close items. */
	agentsMayComplete: z.boolean().optional(),
	staleDays: z.number().int().min(1).max(60).optional(),
	/** The target browser checks use when nobody picks one (ADR-017). */
	defaultTarget: z.enum(['dev', 'preview', 'deployed']).optional(),
	/** Addresses inside the web app that UI shots compare new screens with. */
	referencePages: z
		.array(z.string().regex(/^\/[^\s]{0,198}$/, 'A reference page is an address starting with /'))
		.max(50)
		.optional()
});

const PATCH = [
	'name',
	'webApp',
	'rules',
	'streams',
	'themes',
	'agentsMayComplete',
	'staleDays',
	'defaultTarget',
	'referencePages'
] as const;

// -- FUNCTIONS -- //

/** The projects this person can see: all of them for owners and admins, the ones with a role for everyone else. */
export async function listProjects(ctx: Ctx) {
	return run(ctx, async (tx) => {
		const [m] = await tx
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.orgId, ctx.orgId), eq(member.userId, ctx.actor.userId)));
		if (!m) throw new OpError('FORBIDDEN', 'You are not a member of this organisation.');
		const all = await tx
			.select({ ...projectCols, logoV: projectLogoV })
			.from(project)
			.where(eq(project.orgId, ctx.orgId))
			.orderBy(asc(project.key));
		const overrides = await tx
			.select()
			.from(projectMember)
			.where(eq(projectMember.userId, ctx.actor.userId));
		return all.filter(
			(p) =>
				projectAllowed(ctx.actor, p.id) &&
				effectiveProjectRole(m.role, overrides.find((o) => o.projectId === p.id)?.role ?? null) !==
					null
		);
	});
}

export async function getProject(ctx: Ctx, keyOrId: string) {
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, keyOrId);
		await requireCap(tx, ctx, 'read', p.id);
		return p;
	});
}

/** Creating a project is a manage action (admins and owners). */
export async function createProject(ctx: Ctx, raw: z.input<typeof projectInput>) {
	const input = projectInput.parse(raw);
	return run(ctx, async (tx) => {
		await requireCap(tx, ctx, 'manage');
		const [dupe] = await tx
			.select({ id: project.id })
			.from(project)
			.where(and(eq(project.orgId, ctx.orgId), eq(project.key, input.key)));
		if (dupe) throw new OpError('CONFLICT', `A project with the key ${input.key} already exists.`);
		const [row] = await tx
			.insert(project)
			.values({
				orgId: ctx.orgId,
				key: input.key,
				name: input.name,
				webApp: input.webApp,
				streams: input.streams
			})
			.returning({ ...projectCols, logoV: projectLogoV });
		await tx
			.insert(projectCounter)
			.values({ projectId: row.id, orgId: ctx.orgId, next: 1, nextTask: 1 });
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: row.id,
			...actorFields(ctx),
			verb: 'project.create',
			targetType: 'project',
			targetId: row.id,
			after: { key: row.key, name: row.name } as never,
			undoable: false
		});
		return row;
	});
}

export async function updateProject(ctx: Ctx, raw: z.input<typeof projectUpdateInput>) {
	const input = projectUpdateInput.parse(raw);
	return run(ctx, async (tx) => {
		const p = await findProject(tx, ctx, input.project);
		await requireCap(tx, ctx, 'manage', p.id);
		// The rule that keeps COMPLETED for people cannot be switched off by the agents it restrains (ADR-027)
		if (ctx.actor.kind === 'agent' && input.agentsMayComplete !== undefined)
			throw new OpError('FORBIDDEN', 'Only a person can change whether agents may complete items.');
		checkVersion(p, input.expectVersion);
		const before: Record<string, unknown> = {};
		const after: Record<string, unknown> = {};
		for (const k of PATCH) {
			const v = input[k];
			if (v !== undefined && JSON.stringify(v) !== JSON.stringify(p[k])) {
				before[k] = p[k];
				after[k] = v;
			}
		}
		if (Object.keys(after).length === 0) return { project: p, changed: false };
		const [row] = await tx
			.update(project)
			.set({ ...after, updatedAt: sql`now()`, version: sql`${project.version} + 1` })
			.where(eq(project.id, p.id))
			.returning({ ...projectCols, logoV: projectLogoV });
		await appendEvent(tx, {
			orgId: ctx.orgId,
			projectId: p.id,
			...actorFields(ctx),
			verb: 'project.update',
			targetType: 'project',
			targetId: p.id,
			before: before as never,
			after: after as never,
			undoable: false
		});
		return { project: row, changed: true };
	});
}
