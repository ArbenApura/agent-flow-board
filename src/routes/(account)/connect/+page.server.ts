// IMPORTED DEP-TYPES
import type { Actions, PageServerLoad } from './$types';
import type { Ctx } from '#lib/server/ops/context.js';
// IMPORTED ENVS
import { AFB_BASE_URL } from '$app/env/private';
// IMPORTED DEP-MODULES
import { fail, redirect } from '@sveltejs/kit';
// IMPORTED MODULES
import { agentSetupMarkdown } from '#lib/connect/agentSetup.js';
import { editorSetupMarkdown } from '#lib/connect/editorSetup.js';
import { skillsBriefMarkdown } from '#lib/connect/skillsBrief.js';
import { snippets } from '#lib/connect/snippets.js';
import { orgMcpUrl, toolPrefix } from '#lib/shared/orgConnection.js';
import { getDb } from '#lib/server/db/index.js';
import { listConnections, revokeConnection } from '#lib/server/oauth/oauth.js';
import { capsOf, OpError } from '#lib/server/ops/context.js';
import { bridgeSignIn } from '#lib/server/ops/editorStatus.js';
import { createToken } from '#lib/server/ops/tokens.js';
import { listMyOrgs } from '#lib/server/orgs/orgs.js';
import { systemSkillsIndex } from '#lib/server/system-skills/index.js';

// -- FUNCTIONS -- //

/** The Skills tab: the release, its skills, the newest changelog entries and the brief. The same for everyone; null when the bundle cannot be read. */
function skillsTab() {
	try {
		const index = systemSkillsIndex();
		return {
			bundle: index.bundle,
			skills: index.skills.map((s) => ({
				name: s.name,
				version: s.version,
				description: s.description,
				files: s.files.length
			})),
			changelog: index.changelog.slice(0, 3),
			brief: skillsBriefMarkdown(AFB_BASE_URL, index),
			bundleUrl: '/api/v1/system-skills/bundle.zip'
		};
	} catch (e) {
		// A missing or broken bundle is a build problem: say so in the log, and show the page an error rather than an empty list
		console.error('The system skills bundle cannot be read.', e);
		return null;
	}
}

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
	// The tab is in the address, so a link opens the Skills or the Editor status tab; anything else is the tools tab
	const asked = url.searchParams.get('tab');
	const tab = asked === 'skills' ? 'skills' : asked === 'editor' ? 'editor' : 'tools';
	const skills = skillsTab();
	const got = await personCtx(locals, url.searchParams.get('org'));
	if (!got || got.orgs.length === 0)
		return {
			tab,
			editor: null,
			skills,
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
	// The Editor status tab: who the bridge is signed in as for this organisation, and the prompt. A failed read is said on the tab, never a blank
	const editor =
		tab === 'editor'
			? {
					person: locals.user!.name,
					signIn: await bridgeSignIn(got.ctx).catch((e) => {
						console.error('The bridge sign in of the person could not be read.', e);
						return null;
					}),
					brief: editorSetupMarkdown(AFB_BASE_URL, { slug: org.slug })
				}
			: null;
	return {
		tab,
		editor,
		skills,
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
