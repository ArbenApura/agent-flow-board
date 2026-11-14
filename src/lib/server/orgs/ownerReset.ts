// OWNER RESET FOR SELF HOSTERS WITH NO EMAIL (L11). RUN FROM THE SERVER CLI BY THE OPERATOR, NEVER OVER HTTP.

// IMPORTED TYPES
import type { Auth } from '../auth/auth';
import type { DbHandle } from '../db/client';
// IMPORTED DEP-MODULES
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
// IMPORTED MODULES
import { authAccount, authLockout, authSession, member, org, user } from '../db/schema';
import { MIN_PASSWORD } from '../auth/auth';
import { withTenant } from '../db/tenant';
import { OrgError } from './orgs';

// -- FUNCTIONS -- //

/** A password with plenty of entropy that a person can type once, shown a single time to the operator. */
export function generatePassword(): string {
	return randomBytes(18).toString('base64url');
}

/**
 * Sets a new password for an Owner of the named org, ends their sessions and clears their lockout. It refuses anyone
 * who is not an Owner of that org, so the command cannot be used to take over an ordinary account.
 */
export async function resetOwnerPassword(
	handle: DbHandle,
	auth: Auth,
	input: { orgSlug: string; email: string; newPassword?: string }
) {
	const password = input.newPassword ?? generatePassword();
	if (password.length < MIN_PASSWORD)
		throw new OrgError('INVALID', `A password needs at least ${MIN_PASSWORD} characters.`);
	const email = input.email.trim().toLowerCase();
	const [u] = await handle.db
		.select({ id: user.id })
		.from(user)
		.where(sql`lower(${user.email}) = ${email}`);
	if (!u) throw new OrgError('NOT_FOUND', 'No account has that email address.');
	const owner = await withTenant(handle, { orgSlug: input.orgSlug, userId: u.id }, async (tx) => {
		const [row] = await tx
			.select({ role: member.role })
			.from(member)
			.innerJoin(org, eq(org.id, member.orgId))
			.where(and(eq(org.slug, input.orgSlug), eq(member.userId, u.id)));
		return row?.role === 'owner';
	});
	if (!owner) throw new OrgError('FORBIDDEN', 'That person is not an Owner of this organisation.');
	const hash = await (await auth.$context).password.hash(password);
	const [account] = await handle.db
		.select({ id: authAccount.id })
		.from(authAccount)
		.where(and(eq(authAccount.userId, u.id), eq(authAccount.providerId, 'credential')));
	if (account)
		await handle.db
			.update(authAccount)
			.set({ password: hash, updatedAt: sql`now()` })
			.where(eq(authAccount.id, account.id));
	else
		await handle.db.insert(authAccount).values({
			id: crypto.randomUUID(),
			userId: u.id,
			accountId: u.id,
			providerId: 'credential',
			password: hash
		});
	await handle.db.update(user).set({ emailVerified: true }).where(eq(user.id, u.id));
	await handle.db.delete(authSession).where(eq(authSession.userId, u.id));
	await handle.db.delete(authLockout).where(eq(authLockout.email, email));
	return { email, password };
}
