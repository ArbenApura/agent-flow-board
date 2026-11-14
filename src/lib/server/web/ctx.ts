// BUILDS THE OPERATIONS CONTEXT FOR A PAGE LOAD, FROM THE SIGNED IN PERSON AND THE ORG THE URL NAMES

// IMPORTED TYPES
import type { Ctx } from '../ops/context';
// IMPORTED DEP-MODULES
import { error, redirect } from '@sveltejs/kit';
// IMPORTED MODULES
import { appServices } from '../services';
import { getDb } from '../db/index';
import { OpError } from '../ops/context';
import { orgForSlugIncludingDeleted } from '../orgs/orgs';
import { ROLE_LABEL, type Role } from '../../shared/roles';

// -- TYPES -- //

type Locals = {
	user: {
		id: string;
		name: string;
		emailVerified: boolean;
		email: string;
		image?: string | null;
		updatedAt?: Date;
	} | null;
};

// -- CONSTANTS -- //

/** The lowest role that holds each capability, for the permission panel's wording. */
const CAP_ROLE: Record<string, Role> = {
	read: 'viewer',
	comment: 'viewer',
	write: 'member',
	complete: 'member',
	delete: 'member',
	manage: 'admin'
};

// -- FUNCTIONS -- //

/** The signed in person, or a redirect to sign in that comes back to this page afterwards. */
export function requireUser(locals: Locals, returnTo: string) {
	if (!locals.user) redirect(303, `/sign-in?next=${encodeURIComponent(returnTo)}`);
	return locals.user;
}

/** The org of the URL and a context acting as the signed in person. An unknown org and one the person is not in answer the same 404. */
export async function orgContext(locals: Locals, slug: string, returnTo: string) {
	const user = requireUser(locals, returnTo);
	const handle = await getDb();
	const org = await orgForSlugIncludingDeleted(handle, slug, user.id);
	if (!org) error(404, 'Not found');
	// An org scheduled for deletion has one page of its own, where an owner can restore it
	if (org.deletedAt) redirect(303, `/deleted/${org.slug}`);
	const ctx: Ctx = {
		handle,
		orgId: org.id,
		services: await appServices(),
		actor: { userId: user.id, kind: 'person', label: user.name }
	};
	return { ctx, org, user };
}

/** A context for a child page, from the org its layout already found. */
export async function childContext(locals: Locals, orgId: string): Promise<Ctx> {
	const user = locals.user!;
	return {
		handle: await getDb(),
		orgId,
		services: await appServices(),
		actor: { userId: user.id, kind: 'person', label: user.name }
	};
}

/**
 * Turns an operations error into the page answer. A missing thing is a 404, a refused action is returned for the page to
 * show as a permission panel, and anything else is rethrown for the error handler.
 */
export function pageError(e: unknown): { denied: { needed: string; role: string } } {
	if (e instanceof OpError) {
		if (e.code === 'NOT_FOUND') error(404, 'Not found');
		if (e.code === 'FORBIDDEN')
			return {
				denied: {
					needed: ROLE_LABEL[CAP_ROLE[String(e.details?.needed ?? 'read')] ?? 'admin'],
					role: ROLE_LABEL[(e.details?.role as Role | undefined) ?? 'member'] ?? 'Member'
				}
			};
		if (e.code === 'INVALID') error(400, e.message);
	}
	throw e;
}
