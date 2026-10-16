// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- DEP-MODULES -- //
import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import { userPref } from '#lib/server/db/schema/index.js';
import { withTenant } from '#lib/server/db/tenant.js';
import { MODE_COOKIE } from '#lib/theme/mode.js';

// -- FUNCTIONS -- //

/** Saves the light or dark choice of the signed in person. Nothing else in their preferences changes. */
export const POST: RequestHandler = async ({ locals, request, cookies }) => {
	if (!locals.user) return json({ message: 'Sign in first.' }, { status: 401 });
	const body = (await request.json().catch(() => null)) as { mode?: unknown } | null;
	if (body?.mode !== 'light' && body?.mode !== 'dark')
		return json({ message: 'Pick light or dark.' }, { status: 400 });
	const themeMode = body.mode;
	const userId = locals.user.id;
	await withTenant(await getDb(), { userId }, (tx) =>
		tx
			.insert(userPref)
			.values({ userId, themeMode })
			.onConflictDoUpdate({ target: userPref.userId, set: { themeMode, updatedAt: sql`now()` } })
	);
	cookies.set(MODE_COOKIE, themeMode, { path: '/', maxAge: 31_536_000, httpOnly: false });
	return json({ ok: true });
};
