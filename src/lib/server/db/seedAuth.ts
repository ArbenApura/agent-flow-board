// SIGN IN FOR THE SEEDED PEOPLE, SO UI SHOTS AND BROWSER CHECKS CAN SIGN IN AS AN OWNER, ADMIN, MEMBER OR VIEWER
// Local development and previews only. The password is public on purpose, so it must never reach a deployment.

// -- TYPES -- //
import type { Auth } from '../auth/auth';
import type { DbHandle } from './client';
// -- MODULES -- //
import { authAccount, user } from './schema';
import { SEED_USERS, seedDemo } from './seed';

// -- CONSTANTS -- //

export const SEED_PASSWORD = 'seed-password-for-previews';

// -- FUNCTIONS -- //

/** Seeds the demo data once (when the database holds no users) and gives every seeded person the shared password. */
export async function seedForPreview(handle: DbHandle, auth: Auth): Promise<boolean> {
	const existing = await handle.db.select({ id: user.id }).from(user).limit(1);
	if (existing.length > 0) return false;
	await seedDemo(handle.owner, { loadItems: 5000 });
	const hash = await (await auth.$context).password.hash(SEED_PASSWORD);
	for (const u of SEED_USERS) {
		await handle.db
			.insert(authAccount)
			.values({
				id: `seed-account-${u.id}`,
				userId: u.id,
				accountId: u.id,
				providerId: 'credential',
				password: hash
			})
			.onConflictDoNothing();
	}
	// A self registered looking tool, so the consent screen can be shown with its unverified badge
	await handle.owner.exec(
		`INSERT INTO oauth_client (id, name, redirect_uris, verified) VALUES ('afbc_seedclient', 'Seed Tool', ARRAY['http://127.0.0.1:33418/callback'], false) ON CONFLICT DO NOTHING`
	);
	return true;
}

export const seedEmail = (who: (typeof SEED_USERS)[number]['id']) =>
	SEED_USERS.find((u) => u.id === who)!.email;
