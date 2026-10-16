// TELLING THE PEOPLE WHO MANAGE A PROJECT THAT AUTOMATIC PUBLISH STOPPED, WHEN THEY ASKED TO BE TOLD (SPEC 8, Personal settings)
// A failed mail is logged and never stops the job. Each person's own preference is read as that person.

// -- TYPES -- //
import type { DbHandle } from '../db/client';
import type { Mailer } from '../email/mailer';
// -- DEP-MODULES -- //
import { and, eq, inArray } from 'drizzle-orm';
// -- MODULES -- //
import { member, org, project, user, userPref } from '../db/schema';
import { withTenant } from '../db/tenant';

// -- FUNCTIONS -- //

/** Emails the owners and admins of the org who have not switched "publishing paused" off. Returns how many were mailed. */
export async function notifyPublishPaused(
	deps: { handle: DbHandle; mailer: Mailer; baseUrl: string },
	orgId: string,
	projectId: string,
	reason: string
): Promise<number> {
	const info = await withTenant(deps.handle, { orgId }, async (tx) => {
		const [o] = await tx
			.select({ slug: org.slug, name: org.name, deletedAt: org.deletedAt })
			.from(org)
			.where(eq(org.id, orgId));
		const [p] = await tx
			.select({ key: project.key, name: project.name })
			.from(project)
			.where(eq(project.id, projectId));
		const people = await tx
			.select({ id: user.id, email: user.email, name: user.name })
			.from(member)
			.innerJoin(user, eq(user.id, member.userId))
			.where(and(eq(member.orgId, orgId), inArray(member.role, ['owner', 'admin'])));
		return { o, p, people };
	});
	// Nobody is told about an org that is scheduled for deletion
	if (!info.o || info.o.deletedAt || !info.p) return 0;
	const link = `${deps.baseUrl}/${info.o.slug}/${info.p.key}/settings`;
	let sent = 0;
	for (const person of info.people) {
		const [pref] = await withTenant(deps.handle, { userId: person.id }, (tx) =>
			tx.select().from(userPref).where(eq(userPref.userId, person.id))
		);
		if ((pref?.notifications as { publishPaused?: boolean } | undefined)?.publishPaused === false)
			continue;
		try {
			await deps.mailer.send({
				to: person.email,
				subject: `Publishing of ${info.p.name} is paused`,
				text: `Hello ${person.name},\n\nAutomatic publishing of ${info.p.name} (${info.o.name}) stopped. ${reason}\n\nLook at the settings and turn it on again when it is fixed: ${link}`,
				html: `<p>Hello ${person.name},</p><p>Automatic publishing of ${info.p.name} (${info.o.name}) stopped. ${reason}</p><p><a href="${link}">Open the project settings</a> and turn it on again when it is fixed.</p>`,
				tag: 'publish-paused'
			});
			sent++;
		} catch (e) {
			console.error('The publishing paused mail could not be sent', e);
		}
	}
	return sent;
}
