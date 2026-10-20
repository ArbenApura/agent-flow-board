// -- DEP-TYPES -- //
import type { Actions, PageServerLoad } from './$types';
import type { Ctx } from '#lib/server/ops/context.js';
// -- ENVS -- //
import { AFB_BASE_URL } from '$app/env/private';
// -- DEP-MODULES -- //
import { fail, redirect } from '@sveltejs/kit';
// -- MODULES -- //
import { agentSetupMarkdown } from '#lib/connect/agentSetup.js';
import { snippets } from '#lib/connect/snippets.js';
import { orgMcpUrl, toolPrefix } from '#lib/shared/orgConnection.js';
import { getDb } from '#lib/server/db/index.js';
import { listConnections, revokeConnection } from '#lib/server/oauth/oauth.js';
import { capsOf, OpError } from '#lib/server/ops/context.js';
import { createToken } from '#lib/server/ops/tokens.js';
import { listMyOrgs } from '#lib/server/orgs/orgs.js';

// -- FUNCTIONS -- //

async function personCtx(
	locals: App.Locals,
	orgSlug: string | null,
	strict = false
): Promise<{ ctx: Ctx; orgs: Awaited<ReturnType<typeof listMyOrgs>> } | null> {
	if (!locals.user) return null;
	const handle = await getDb();
	// An org scheduled for deletion cannot be connected to
	const orgs = (await listMyOrgs(handle, locals.user.id)).filter((o) => !o.deletedAt);
	// The page falls back to the first org for a slug it does not know. An action never does: it acts on the org the form names, or on none
	const org = orgs.find((o) => o.slug === orgSlug) ?? (strict ? undefined : orgs[0]);
	if (!org) return { ctx: null as never, orgs };
	return {
		ctx: {
			handle,
			orgId: org.id,
			actor: { userId: locals.user.id, kind: 'person', label: locals.user.name }
		},
		orgs
	};
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(303, `/sign-in?next=${encodeURIComponent('/connect')}`);
	const got = await personCtx(locals, url.searchParams.get('org'));
	if (!got || got.orgs.length === 0)
		return {
			baseUrl: AFB_BASE_URL,
			snippets: snippets(AFB_BASE_URL),
			agentSetup: '',
			ownAddress: '',
			prefix: '',
			orgs: [],
			org: null,
			connections: [],
			caps: []
		};
	const org = got.orgs.find((o) => o.id === got.ctx.orgId)!;
	const connections = await listConnections(got.ctx);
	return {
		baseUrl: AFB_BASE_URL,
		// The snippets and the brief use the org that was resolved above, never the raw ?org= value
		snippets: snippets(AFB_BASE_URL, org.slug),
		agentSetup: agentSetupMarkdown(AFB_BASE_URL, { slug: org.slug, name: org.name }),
		ownAddress: orgMcpUrl(AFB_BASE_URL, org.slug),
		prefix: toolPrefix(org.slug),
		orgs: got.orgs,
		org,
		connections,
		caps: capsOf(org.role)
	};
};

export const actions: Actions = {
	createToken: async ({ request, locals }) => {
		const data = await request.formData();
		const got = await personCtx(locals, String(data.get('org') ?? ''), true);
		if (!got?.ctx) return fail(400, { message: 'Choose an organisation first.' });
		try {
			const made = await createToken(got.ctx, {
				name: String(data.get('name') ?? ''),
				days: Number(data.get('days') ?? 30),
				permissions: data.getAll('permission').map(String) as never
			});
			return {
				created: {
					token: made.token,
					name: String(data.get('name') ?? ''),
					expiresAt: made.expiresAt.toISOString()
				}
			};
		} catch (e) {
			if (e instanceof OpError) return fail(400, { message: e.message });
			return fail(400, {
				message:
					'Give the token a name of at least two letters, pick at most 90 days, and choose at least one permission.'
			});
		}
	},
	revoke: async ({ request, locals }) => {
		const data = await request.formData();
		const got = await personCtx(locals, String(data.get('org') ?? ''), true);
		if (!got?.ctx) return fail(400, { message: 'Choose an organisation first.' });
		try {
			await revokeConnection(got.ctx, String(data.get('id') ?? ''));
		} catch (e) {
			if (e instanceof OpError) return fail(400, { message: e.message });
			throw e;
		}
		return { revoked: true };
	}
};
