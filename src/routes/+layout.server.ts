// -- DEP-TYPES -- //
import type { LayoutServerLoad } from './$types';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import { userPref } from '#lib/server/db/schema/index.js';
import { withTenant } from '#lib/server/db/tenant.js';
import { eq } from 'drizzle-orm';
import { storedPalette } from '#lib/theme/css.js';
import { MODE_COOKIE, parseMode } from '#lib/theme/mode.js';
import { generatePalette } from '#lib/theme/palette.js';

// -- FUNCTIONS -- //

/**
 * What every page needs about the person: their own accent colour, and their saved theme choice. A choice saved on another
 * device is put into this browser's cookie the first time, so the first paint is right here too.
 */
export const load: LayoutServerLoad = async ({ locals, cookies }) => {
	if (!locals.user) return { personalPalette: null };
	const [pref] = await withTenant(await getDb(), { userId: locals.user.id }, (tx) =>
		tx.select().from(userPref).where(eq(userPref.userId, locals.user!.id))
	);
	if (pref && !cookies.get(MODE_COOKIE) && parseMode(pref.themeMode) !== 'system')
		cookies.set(MODE_COOKIE, pref.themeMode, { path: '/', maxAge: 31_536_000, httpOnly: false });
	return {
		personalPalette: pref?.accent ? storedPalette(generatePalette(pref.accent)) : null
	};
};
