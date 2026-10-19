// -- DEP-TYPES -- //
import type { Actions, PageServerLoad } from './$types';
// -- DEP-MODULES -- //
import { fail } from '@sveltejs/kit';
// -- MODULES -- //
import { OpError } from '#lib/server/ops/context.js';
import {
	getOrgSettings,
	orgAuditLog,
	orgBackups,
	emailStatus,
	sendTestEmail
} from '#lib/server/ops/settings.js';
import { listInvites } from '#lib/server/orgs/invites.js';
import { listSkills, orgSkillAccess } from '#lib/server/ops/skills.js';
import { listMembers, membersFor } from '#lib/server/orgs/orgs.js';
import { childContext, orgContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** Everything the Organisation settings page shows. Members may look, admins and owners change. */
export const load: PageServerLoad = async ({ parent, locals, depends }) => {
	depends('afb:settings');
	const { org } = await parent();
	const ctx = await childContext(locals, org.id);
	const settings = await getOrgSettings(ctx);
	const [members, invites, backups, audit, skillAccess] = await Promise.all([
		listMembers(ctx.handle, org.id),
		settings.canManage
			? listInvites(ctx.handle, org.id, locals.user!.id).catch(() => [])
			: Promise.resolve([]),
		settings.canManage ? orgBackups(ctx) : Promise.resolve(null),
		settings.canManage ? orgAuditLog(ctx, { limit: 25 }) : Promise.resolve(null),
		orgSkillAccess(ctx)
	]);
	// A guest never sees a skill, so none is read for them
	const skills = skillAccess.guest
		? []
		: (await listSkills(ctx, {})).map((s) => ({
				id: s.id,
				name: s.name,
				summary: s.summary,
				files: s.files,
				author: s.author,
				revision: s.revision,
				version: s.version,
				updatedAt: s.updatedAt.toISOString()
			}));
	return {
		settings,
		members: membersFor(members, locals.user!.id),
		invites,
		backups,
		audit,
		skillAccess,
		skills,
		email: emailStatus(ctx)
	};
};

export const actions: Actions = {
	/** Sends a test email to the person asking, so a wrong setting shows up now and not at the first real invitation. */
	testEmail: async ({ locals, params, url }) => {
		const { ctx } = await orgContext(locals, params.org, url.pathname);
		try {
			const r = await sendTestEmail(ctx, locals.user!.email);
			return { sent: true, via: r.via, to: locals.user!.email };
		} catch (e) {
			if (e instanceof OpError) return fail(400, { sent: false, message: e.message });
			return fail(400, {
				sent: false,
				message: e instanceof Error ? e.message : 'The test email could not be sent.'
			});
		}
	}
};
