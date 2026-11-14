// L4: AN UNVERIFIED PASSWORD ACCOUNT IS DISCARDED WHEN THE REAL OWNER OF THE EMAIL SIGNS IN WITH GOOGLE
// Without this, someone could register a victim's address with a password they chose and wait. Linking only ever
// happens into a verified account (Better Auth's requireLocalEmailVerified), and an unverified duplicate is removed
// so the owner gets a clean account that no one else holds a password for.

// IMPORTED TYPES
import type { Db } from '../db/client';
// IMPORTED DEP-MODULES
import { and, eq, sql } from 'drizzle-orm';
// IMPORTED MODULES
import { authAccount, user } from '../db/schema';

// -- FUNCTIONS -- //

/**
 * Deletes a user with this email when the email was never verified, together with its accounts and sessions
 * (the cascade does that). Returns whether one was removed. Events they authored are anonymised by the caller's
 * deletion routine, not lost.
 */
export async function purgeUnverifiedDuplicate(db: Db, email: string): Promise<boolean> {
	const e = email.trim().toLowerCase();
	const rows = await db
		.select({ id: user.id })
		.from(user)
		.where(and(sql`lower(${user.email}) = ${e}`, eq(user.emailVerified, false)));
	if (rows.length === 0) return false;
	for (const r of rows) {
		// A verified password or Google account is never touched, only users that never proved the address
		const [anyVerifiedAccount] = await db
			.select({ id: authAccount.id })
			.from(authAccount)
			.where(and(eq(authAccount.userId, r.id), eq(authAccount.providerId, 'google')));
		if (anyVerifiedAccount) continue;
		await db.delete(user).where(eq(user.id, r.id));
	}
	return true;
}

/**
 * The hook for the Google provider's mapProfileToUser. Google only counts when it vouches for the address.
 * It returns no overrides, the removal is its only effect.
 */
export function googleProfileGuard(db: Db) {
	return async (profile: { email?: string | null; email_verified?: boolean }) => {
		if (profile.email && profile.email_verified === true)
			await purgeUnverifiedDuplicate(db, profile.email);
		return {};
	};
}
