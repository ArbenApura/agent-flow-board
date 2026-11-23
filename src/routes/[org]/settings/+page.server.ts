// IMPORTED DEP-TYPES
import type { Actions, PageServerLoad } from './$types';
// IMPORTED DEP-MODULES
import { fail } from '@sveltejs/kit';
import { ZodError } from 'zod';
// IMPORTED MODULES
import { OpError } from '#lib/server/ops/context.js';
import { getAuthMethods, updateAuthMethods } from '#lib/server/ops/authMethods.js';
import {
	backupDelete,
	getOrgSettings,
	orgAuditLog,
	orgBackups,
	emailStatus,
	sendTestEmail
} from '#lib/server/ops/settings.js';
import { listInvites } from '#lib/server/orgs/invites.js';
import { listMembers, listProjectRoles, membersFor } from '#lib/server/orgs/orgs.js';
import { childContext, orgContext } from '#lib/server/web/ctx.js';

// -- FUNCTIONS -- //

/** Everything the Organisation settings page shows. Members may look, admins and owners change. */
export const load: PageServerLoad = async ({ parent, locals, depends }) => {
	depends('afb:settings');
	const { org } = await parent();
	const ctx = await childContext(locals, org.id);
	const settings = await getOrgSettings(ctx);
	const [members, invites, projectRoles, backups, audit] = await Promise.all([
		listMembers(ctx.handle, org.id),
		settings.canManage
			? listInvites(ctx.handle, org.id, locals.user!.id).catch(() => [])
			: Promise.resolve([]),
		// The per project roles are only needed by the people who may change them
		settings.canManage ? listProjectRoles(ctx.handle, org.id) : Promise.resolve([]),
		settings.canManage ? orgBackups(ctx) : Promise.resolve(null),
		settings.canManage ? orgAuditLog(ctx, { limit: 25 }) : Promise.resolve(null)
	]);
	// How people sign in is for owners only, and the verb checks the live role again
	const authMethods = org.role === 'owner' ? await getAuthMethods(ctx) : null;
	return {
		authMethods,
		settings,
		members: membersFor(members, locals.user!.id),
		// Only what the list shows: the stored token hash never leaves the server
		invites: invites.map((i) => ({
			id: i.id,
			email: i.email,
			role: i.role,
			createdAt: i.createdAt,
			invitedBy: i.invitedBy
		})),
		projectRoles,
		backups,
		audit,
		email: emailStatus(ctx)
	};
};

export const actions: Actions = {
	/** Saves the sign in methods. Owners only, checked by the verb. The secret is sent only when a new one was typed. */
	saveMethods: async ({ request, locals, params, url }) => {
		const { ctx } = await orgContext(locals, params.org, url.pathname);
		const form = await request.formData();
		const clientId = String(form.get('googleClientId') ?? '').trim();
		const secret = String(form.get('googleClientSecret') ?? '').trim();
		try {
			await updateAuthMethods(ctx, {
				passwordEnabled: form.get('passwordEnabled') === '1',
				googleEnabled: form.get('googleEnabled') === '1',
				...(clientId ? { googleClientId: clientId } : {}),
				...(secret ? { googleClientSecret: secret } : {})
			});
			return { methodsSaved: true };
		} catch (e) {
			if (e instanceof OpError) return fail(400, { methodsSaved: false, message: e.message });
			if (e instanceof ZodError)
				return fail(400, {
					methodsSaved: false,
					message: e.issues[0]?.message ?? 'Check the values.'
				});
			return fail(400, { methodsSaved: false, message: 'That was not saved.' });
		}
	},

	/** Deletes the chosen backups, the stored file first and then the record. Admins and owners only, checked by the verb. */
	deleteBackups: async ({ request, locals, params, url }) => {
		const { ctx } = await orgContext(locals, params.org, url.pathname);
		const form = await request.formData();
		const ids = form.getAll('id').map(String);
		try {
			const r = await backupDelete(ctx, { ids });
			return { backupsDeleted: r.deleted, backupsFailed: r.failed };
		} catch (e) {
			if (e instanceof OpError) return fail(400, { backupsDeleted: 0, message: e.message });
			return fail(400, { backupsDeleted: 0, message: 'The backups could not be deleted.' });
		}
	},

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
