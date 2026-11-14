// IMPORTED DEP-TYPES
import type { Actions, PageServerLoad } from './$types';
// IMPORTED DEP-MODULES
import { fail } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
// IMPORTED MODULES
import { avatarVersion } from '#lib/board/pictures.js';
import { getAuth } from '#lib/server/auth/index.js';
import { getDb } from '#lib/server/db/index.js';
import { continueChoice } from '#lib/server/db/zod.js';
import { userPref } from '#lib/server/db/schema/index.js';
import { withTenant } from '#lib/server/db/tenant.js';
import { listTokens } from '#lib/server/ops/tokens.js';
import { listMyOrgs } from '#lib/server/orgs/orgs.js';
import { saveContinueChoice } from '#lib/server/web/continuePref.js';
import { requireUser } from '#lib/server/web/ctx.js';
import { MODE_COOKIE, parseMode } from '#lib/theme/mode.js';

// -- CONSTANTS -- //

const TARGETS = ['dev', 'preview', 'deployed'];

// -- FUNCTIONS -- //

const messageOf = (e: unknown, fallback: string) =>
	(e as { body?: { message?: string } })?.body?.message ??
	(e instanceof Error && e.message ? e.message : fallback);

/** The person's own settings: profile, how they sign in, their sessions, the tools they connected, and their preferences. */
export const load: PageServerLoad = async ({ locals, request, url, depends }) => {
	depends('afb:me');
	const user = requireUser(locals, url.pathname);
	const handle = await getDb();
	const auth = await getAuth();
	const [sessions, accounts, orgs, pref] = await Promise.all([
		auth.api.listSessions({ headers: request.headers }),
		auth.api.listUserAccounts({ headers: request.headers }),
		listMyOrgs(handle, user.id),
		withTenant(handle, { userId: user.id }, (tx) => tx.select().from(userPref))
	]);
	const tools = [];
	for (const o of orgs) {
		// An org scheduled for deletion has no working tokens, and asking it for them is refused
		if (o.deletedAt) continue;
		const ctx = {
			handle,
			orgId: o.id,
			actor: { userId: user.id, kind: 'person' as const, label: user.name }
		};
		// Only tokens that still work: a revoked or expired one is gone from this list
		for (const t of await listTokens(ctx))
			if (!t.revokedAt && t.expiresAt.getTime() > Date.now())
				tools.push({ ...t, org: o.slug, orgName: o.name });
	}
	const p = pref[0];
	return {
		me: { id: user.id, name: user.name, email: user.email, imageV: avatarVersion(user) },
		sessions: sessions.map((s) => ({
			token: s.token,
			current: s.token === locals.session?.token,
			userAgent: s.userAgent ?? '',
			ipAddress: s.ipAddress ?? '',
			createdAt: s.createdAt,
			expiresAt: s.expiresAt
		})),
		methods: accounts.map((a) => a.providerId),
		tools,
		prefs: {
			themeMode: parseMode(p?.themeMode),
			checkTarget: p?.checkTarget ?? '',
			notifications: {
				backupAlerts:
					(p?.notifications as { backupAlerts?: boolean } | undefined)?.backupAlerts ?? true
			}
		}
	};
};

export const actions: Actions = {
	profile: async ({ locals, request }) => {
		requireUser(locals, '/settings');
		const name = String((await request.formData()).get('name') ?? '').trim();
		if (name.length < 2 || name.length > 80)
			return fail(400, { message: 'Your name must be 2 to 80 characters.' });
		try {
			await (await getAuth()).api.updateUser({ headers: request.headers, body: { name } });
			return { saved: 'profile' };
		} catch (e) {
			return fail(400, { message: messageOf(e, 'Your name was not saved.') });
		}
	},

	password: async ({ locals, request }) => {
		requireUser(locals, '/settings');
		const f = await request.formData();
		const current = String(f.get('current') ?? '');
		const next = String(f.get('next') ?? '');
		if (!current || !next)
			return fail(400, { message: 'Enter your current password and a new one.' });
		try {
			await (
				await getAuth()
			).api.changePassword({
				headers: request.headers,
				body: { currentPassword: current, newPassword: next, revokeOtherSessions: true }
			});
			return { saved: 'password' };
		} catch (e) {
			return fail(400, { message: messageOf(e, 'The password was not changed.') });
		}
	},

	revoke: async ({ locals, request }) => {
		requireUser(locals, '/settings');
		const token = String((await request.formData()).get('token') ?? '');
		if (!token) return fail(400, { message: 'No session was named.' });
		try {
			await (await getAuth()).api.revokeSession({ headers: request.headers, body: { token } });
			return { saved: 'session' };
		} catch (e) {
			return fail(400, { message: messageOf(e, 'That session could not be ended.') });
		}
	},

	revokeOthers: async ({ locals, request }) => {
		requireUser(locals, '/settings');
		try {
			await (await getAuth()).api.revokeOtherSessions({ headers: request.headers });
			return { saved: 'sessions' };
		} catch (e) {
			return fail(400, { message: messageOf(e, 'The other sessions could not be ended.') });
		}
	},

	/** The tool and the way "Continue with" starts with. Only these two columns change. */
	continue: async ({ locals, request }) => {
		const user = requireUser(locals, '/settings');
		const f = await request.formData();
		const parsed = continueChoice.safeParse({
			continueTool: f.get('continueTool'),
			continueMode: f.get('continueMode')
		});
		if (!parsed.success)
			return fail(400, { message: parsed.error.issues[0]?.message ?? 'Pick a tool and a way.' });
		await saveContinueChoice(user.id, parsed.data);
		return { saved: 'continue' };
	},

	prefs: async ({ locals, request, cookies }) => {
		const user = requireUser(locals, '/settings');
		const f = await request.formData();
		const themeMode = parseMode(String(f.get('themeMode') ?? ''));
		const checkTarget = String(f.get('checkTarget') ?? '');
		if (checkTarget && !TARGETS.includes(checkTarget))
			return fail(400, { message: 'Pick dev, preview or deployed.' });
		const notifications = {
			backupAlerts: f.get('backupAlerts') === 'on'
		};
		const values = {
			userId: user.id,
			themeMode,
			checkTarget: checkTarget || null,
			notifications
		};
		await withTenant(await getDb(), { userId: user.id }, (tx) =>
			tx
				.insert(userPref)
				.values(values)
				.onConflictDoUpdate({
					target: userPref.userId,
					set: { ...values, updatedAt: sql`now()` }
				})
		);
		cookies.set(MODE_COOKIE, themeMode, { path: '/', maxAge: 31_536_000, httpOnly: false });
		return { saved: 'prefs' };
	}
};
