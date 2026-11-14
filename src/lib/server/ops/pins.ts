// PINNED PROJECTS: A PERSONAL SHORTCUT ON THE ORG HOME (AFB-20261017-0537)
// A pin belongs to one person and is invisible to everyone else. The row filter names the org and the person, and the verbs
// always write the caller's own id, never one that came from the request.

// IMPORTED TYPES
import type { Ctx } from './context';
// IMPORTED DEP-MODULES
import { and, eq, sql } from 'drizzle-orm';
// IMPORTED MODULES
import { member, project, projectPin } from '../db/schema';
import { OpError, requireCap, run } from './context';
import { findProject, isUuid } from './resolve';

// -- FUNCTIONS -- //

/** Pins a project for the caller. Pinning it again changes nothing. A project the caller cannot see answers NOT FOUND. */
export async function pinProject(ctx: Ctx, projectKeyOrId: string) {
	return run(ctx, async (tx) => {
		const proj = await findProject(tx, ctx, projectKeyOrId);
		// A pin is a personal preference, so reading the project is enough. This also applies the org lock and token limits
		await requireCap(tx, ctx, 'read', proj.id);
		await tx
			.insert(projectPin)
			.values({ orgId: ctx.orgId, projectId: proj.id, userId: ctx.actor.userId })
			.onConflictDoNothing({ target: [projectPin.userId, projectPin.projectId] });
		return { projectId: proj.id, key: proj.key, pinned: true as const };
	});
}

/**
 * Removes the caller's pin, for a project named by key or id. It needs org membership only, so a person who lost access to a
 * project can still clear its pin. A project that was never pinned, or that the caller cannot see, answers the same way.
 */
export async function unpinProject(ctx: Ctx, projectKeyOrId: string) {
	return run(ctx, async (tx) => {
		const [m] = await tx
			.select({ role: member.role })
			.from(member)
			.where(and(eq(member.orgId, ctx.orgId), eq(member.userId, ctx.actor.userId)));
		if (!m) throw new OpError('FORBIDDEN', 'You are not a member of this organisation.');
		const q = projectKeyOrId.trim();
		// Looked up by name inside the org only, with no access check on purpose: the answer is the same either way
		const [proj] = await tx
			.select({ id: project.id, key: project.key })
			.from(project)
			.where(
				and(
					eq(project.orgId, ctx.orgId),
					isUuid(q) ? eq(project.id, q) : sql`upper(${project.key}) = ${q.toUpperCase()}`
				)
			);
		if (proj)
			await tx
				.delete(projectPin)
				.where(
					and(
						eq(projectPin.orgId, ctx.orgId),
						eq(projectPin.userId, ctx.actor.userId),
						eq(projectPin.projectId, proj.id)
					)
				);
		// The answer never names the project, so a project the caller cannot see is not confirmed or identified
		return { pinned: false as const };
	});
}

/** The project ids the caller pinned in this org. Rows for projects the caller can no longer see are filtered by the caller. */
export async function pinnedProjectIds(tx: Parameters<Parameters<typeof run>[1]>[0], ctx: Ctx) {
	const rows = await tx
		.select({ projectId: projectPin.projectId })
		.from(projectPin)
		.where(and(eq(projectPin.orgId, ctx.orgId), eq(projectPin.userId, ctx.actor.userId)));
	return new Set(rows.map((r) => r.projectId));
}
