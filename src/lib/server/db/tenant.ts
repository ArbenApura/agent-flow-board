// TRANSACTION LOCAL TENANT CONTEXT (L5). EVERY REQUEST, JOB AND THE IMPORTER RUNS ITS QUERIES THROUGH withTenant.
// The setting lives only inside the transaction (set_config with is_local = true), so a pooled connection can never
// carry one request's tenant into the next one.

// -- TYPES -- //
import type { DbHandle, Tx } from './client';
// -- DEP-MODULES -- //
import { sql } from 'drizzle-orm';
import pg from 'pg';
// -- MODULES -- //
import { RUNTIME_ROLE } from './security';

// -- TYPES -- //

export type Tenant = {
	orgId?: string;
	/** Names an org by its slug, so a URL can find its org before the id is known. Only that org row is visible. */
	orgSlug?: string;
	/** Narrows project scoped tables to one project. Left out, the whole org is visible to the org checks. */
	projectId?: string;
	userId?: string;
	/** Lets the purge sweep list the orgs an owner deleted, and nothing else. Used by no request path. */
	purgeSweep?: boolean;
	/** The sha256 of a public mockup address. Lets the mockup row of that one link be read, and nothing else. */
	mockupTokenHash?: string;
};

// -- FUNCTIONS -- //

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Refuses anything that is not a UUID before it reaches the database. */
function uuidOrEmpty(value: string | undefined, name: string): string {
	if (value === undefined) return '';
	if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
	return value;
}

/**
 * Runs `fn` in one transaction with the tenant set. Without an org, no tenant row is visible, so a call that
 * forgot its context reads nothing instead of everything.
 */
export async function withTenant<T>(
	handle: DbHandle,
	tenant: Tenant,
	fn: (tx: Tx) => Promise<T>
): Promise<T> {
	const org = uuidOrEmpty(tenant.orgId, 'orgId');
	const project = uuidOrEmpty(tenant.projectId, 'projectId');
	const userId = tenant.userId ?? '';
	const orgSlug = tenant.orgSlug ?? '';
	const purgeSweep = tenant.purgeSweep ? 'on' : '';
	const tokenHash = tenant.mockupTokenHash ?? '';
	if (tokenHash && !/^[0-9a-f]{64}$/.test(tokenHash))
		throw new Error('mockupTokenHash must be a sha256 hex string');
	return handle.db.transaction(async (tx) => {
		// One round trip for the whole setup. The values are escaped as literals, and the ids are checked above
		const lit = (v: string) => pg.escapeLiteral(v);
		const role = handle.switchRole ? `SET LOCAL ROLE ${RUNTIME_ROLE}; ` : '';
		await tx.execute(
			sql.raw(
				`${role}select set_config('app.org_id', ${lit(org)}, true), set_config('app.project_id', ${lit(project)}, true), set_config('app.user_id', ${lit(userId)}, true), set_config('app.org_slug', ${lit(orgSlug)}, true), set_config('app.purge_sweep', ${lit(purgeSweep)}, true), set_config('app.mockup_token_hash', ${lit(tokenHash)}, true)`
			)
		);
		return fn(tx);
	});
}
