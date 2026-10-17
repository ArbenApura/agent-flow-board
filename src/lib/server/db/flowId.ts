// ALLOCATING THE REFERENCE OF A NEW ITEM: <PROJECT KEY>-YYYYMMDD-HHMM IN UTC, WITH -b, -c ... WHEN THE MINUTE IS TAKEN (FLOW-20261017-0950)
// The unique indexes item_org_ref_uq and item_alias_org_alias_uq are plain text on two tables, so they cannot see a lower case alias
// or a clash between a ref and an alias. findItem matches upper() and reads the ref before the alias. So the check here compares
// upper() on both tables, and the unique index is only the last guard.

// -- TYPES -- //
import type { Tx } from './client';
// -- DEP-MODULES -- //
import { and, eq, inArray, sql } from 'drizzle-orm';
// -- MODULES -- //
import { refCandidates } from '../../shared/ref';
import { item, itemAlias } from './schema';

// -- CONSTANTS -- //

/** How many candidates one create tries before it gives up. */
export const REF_TRIES = 25;
const REF_INDEX = 'item_org_ref_uq';

// -- TYPES -- //

type NewItem = Omit<typeof item.$inferInsert, 'ref'>;

/** Every candidate of the minute is taken. */
export class RefSuffixesTaken extends Error {
	constructor() {
		super('Every suffix for this minute is taken. Wait a minute and retry.');
		this.name = 'RefSuffixesTaken';
	}
}

// -- FUNCTIONS -- //

/** True when an error, or the error it wraps, is a unique violation of the reference index. */
export function isRefConflict(error: unknown): boolean {
	for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
		const err = e as { code?: string; constraint?: string; cause?: unknown };
		if (err.code === '23505' && (err.constraint === undefined || err.constraint === REF_INDEX))
			return true;
		e = err.cause;
	}
	return false;
}

/** The candidates that are in use in the org, as an item ref or as an alias, compared in upper case. Trashed items count. */
export async function takenRefs(tx: Tx, orgId: string, candidates: string[]): Promise<Set<string>> {
	if (!candidates.length) return new Set();
	const upper = candidates.map((c) => c.toUpperCase());
	const refs = await tx
		.select({ value: item.ref })
		.from(item)
		.where(and(eq(item.orgId, orgId), inArray(sql`upper(${item.ref})`, upper)));
	const aliases = await tx
		.select({ value: itemAlias.alias })
		.from(itemAlias)
		.where(and(eq(itemAlias.orgId, orgId), inArray(sql`upper(${itemAlias.alias})`, upper)));
	return new Set([...refs, ...aliases].map((r) => r.value.toUpperCase()));
}

/** The candidates for a moment that are still free, in order. The first one is the reference to use. */
export async function freeRefs(
	tx: Tx,
	orgId: string,
	key: string,
	at: Date,
	startSuffix = ''
): Promise<string[]> {
	const candidates = refCandidates(key, at, startSuffix);
	const taken = await takenRefs(tx, orgId, candidates);
	return candidates.filter((c) => !taken.has(c.toUpperCase()));
}

/** The reference to use for an item made at a moment. Throws when every suffix of the minute is taken. */
export async function allocateItemRef(
	tx: Tx,
	orgId: string,
	key: string,
	at: Date,
	startSuffix = ''
): Promise<string> {
	const [first] = await freeRefs(tx, orgId, key, at, startSuffix);
	if (!first) throw new RefSuffixesTaken();
	return first;
}

/**
 * Inserts the item with the first candidate that works. A unique violation of the reference index, inside a savepoint, moves on to the
 * next candidate, at most REF_TRIES. Any other error is raised. The caller takes the item number before this, so a retry never uses a
 * second number.
 */
export async function insertItemWithFreshRef(tx: Tx, candidates: string[], values: NewItem) {
	for (const ref of candidates.slice(0, REF_TRIES)) {
		try {
			const [row] = await tx.transaction(async (sp) =>
				sp
					.insert(item)
					.values({ ...values, ref })
					.returning()
			);
			return row;
		} catch (error) {
			if (!isRefConflict(error)) throw error;
		}
	}
	throw new RefSuffixesTaken();
}
