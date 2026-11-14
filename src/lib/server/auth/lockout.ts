// SIGN IN LOCKOUT. REPEATED FAILED PASSWORDS LOCK THE ACCOUNT FOR A WHILE, AND THE LOCK GROWS WITH EACH ROUND (SPEC 6.1)

// IMPORTED TYPES
import type { Db } from '../db/client';
// IMPORTED DEP-MODULES
import { eq, sql } from 'drizzle-orm';
// IMPORTED MODULES
import { authLockout } from '../db/schema';

// -- CONSTANTS -- //

export const MAX_FAILURES = 5;
const BASE_LOCK_MINUTES = 5;
const MAX_LOCK_MINUTES = 24 * 60;

// -- FUNCTIONS -- //

const key = (email: string) => email.trim().toLowerCase();

/** How long a lock lasts after `failures` failures in a row: 5 minutes at the limit, doubling each further round. */
export function lockMinutes(failures: number): number {
	if (failures < MAX_FAILURES) return 0;
	const rounds = Math.floor(failures / MAX_FAILURES) - 1;
	return Math.min(BASE_LOCK_MINUTES * 2 ** rounds, MAX_LOCK_MINUTES);
}

/** Minutes left on a lock, or 0 when the account is not locked. */
export async function lockedMinutes(db: Db, email: string, now = new Date()): Promise<number> {
	const [row] = await db
		.select()
		.from(authLockout)
		.where(eq(authLockout.email, key(email)));
	if (!row?.lockedUntil || row.lockedUntil <= now) return 0;
	return Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 60_000);
}

/** Counts one failed password. Returns the minutes the account is now locked for, or 0. */
export async function recordFailure(db: Db, email: string, now = new Date()): Promise<number> {
	const e = key(email);
	const [row] = await db
		.insert(authLockout)
		.values({ email: e, failures: 1, updatedAt: now })
		.onConflictDoUpdate({
			target: authLockout.email,
			set: { failures: sql`${authLockout.failures} + 1`, updatedAt: now }
		})
		.returning();
	const minutes = lockMinutes(row.failures);
	if (minutes > 0) {
		await db
			.update(authLockout)
			.set({ lockedUntil: new Date(now.getTime() + minutes * 60_000) })
			.where(eq(authLockout.email, e));
	}
	return minutes;
}

/** A correct password clears the count. */
export async function recordSuccess(db: Db, email: string): Promise<void> {
	await db.delete(authLockout).where(eq(authLockout.email, key(email)));
}
