// RENAMING EXISTING ITEMS TO THE STAMP FORM, <PROJECT KEY>-YYYYMMDD-HHMM IN UTC (FLOW-20261017-0950, SPEC 4.4)
// Works one org at a time inside withTenant as app_runtime, trashed items included. An item already in stamp form is left alone, so a
// second run changes nothing. The old reference stays as an alias, so every old link, commit subject and chat keeps working.

// IMPORTED TYPES
import type { DbHandle, Tx } from './client';
// IMPORTED DEP-MODULES
import { and, eq } from 'drizzle-orm';
// IMPORTED MODULES
import { isStampRef, legacyMoment, refCandidates } from '../../shared/ref';
import { item, itemAlias, project } from './schema';
import { withTenant } from './tenant';

// -- TYPES -- //

export type Rename = {
	id: string;
	projectId: string;
	from: string;
	to: string;
	/** Where its moment came from: the legacy HAPR Board id, or the time it was created here. */
	source: 'legacy id' | 'creation time';
};
export type Skip = { id: string; ref: string; reason: string };
export type OrgPlan = {
	orgId: string;
	renames: Rename[];
	skipped: Skip[];
	/** Items already in stamp form, left alone. */
	alreadyDone: number;
};

type Candidate = {
	id: string;
	projectId: string;
	ref: string;
	key: string;
	at: Date;
	suffix: string;
	legacy: string;
	createdAt: Date;
	number: number;
	source: Rename['source'];
};

// -- FUNCTIONS -- //

/** The ids of the orgs a rename may touch: not deleted and not being purged. Read with the owner connection, and nothing else is. */
export async function liveOrgIds(handle: DbHandle): Promise<string[]> {
	const rows = await handle.owner.query<{ id: string }>(
		'select id from org where deleted_at is null and purge_started_at is null order by id'
	);
	return rows.map((r) => r.id);
}

/**
 * What would change in one org. Imported plans take their moment from the legacy id (read as +08:00, returned as UTC); plans made here
 * from their creation time. In a shared minute the plain stamp goes first, then -b, -c: imported plans in the order of their legacy id
 * text, the others by creation time then number. Every ref and alias in the org counts as taken, upper case, like findItem compares.
 */
export async function planOrgRenames(tx: Tx, orgId: string): Promise<OrgPlan> {
	const items = await tx
		.select({
			id: item.id,
			ref: item.ref,
			number: item.number,
			projectId: item.projectId,
			createdAt: item.createdAt
		})
		.from(item)
		.where(eq(item.orgId, orgId));
	const aliases = await tx
		.select({ alias: itemAlias.alias, itemId: itemAlias.itemId })
		.from(itemAlias)
		.where(eq(itemAlias.orgId, orgId));
	const projects = await tx
		.select({ id: project.id, key: project.key })
		.from(project)
		.where(eq(project.orgId, orgId));
	const keyOf = new Map(projects.map((p) => [p.id, p.key]));
	const aliasesOf = new Map<string, string[]>();
	for (const a of aliases) aliasesOf.set(a.itemId, [...(aliasesOf.get(a.itemId) ?? []), a.alias]);
	const aliasOwner = new Map(aliases.map((a) => [a.alias.toUpperCase(), a.itemId]));
	const occupied = new Set(
		[...items.map((i) => i.ref), ...aliases.map((a) => a.alias)].map((v) => v.toUpperCase())
	);

	const todo: Candidate[] = [];
	const skipped: Skip[] = [];
	let alreadyDone = 0;
	for (const it of items) {
		if (isStampRef(it.ref)) {
			alreadyDone++;
			continue;
		}
		const key = keyOf.get(it.projectId);
		if (!key) {
			skipped.push({ id: it.id, ref: it.ref, reason: 'its project was not found' });
			continue;
		}
		const found = (aliasesOf.get(it.id) ?? [])
			.map((alias) => ({ alias, moment: legacyMoment(alias) }))
			.filter((x) => x.moment)
			.sort((x, y) => (x.alias < y.alias ? -1 : 1))[0];
		todo.push({
			id: it.id,
			projectId: it.projectId,
			ref: it.ref,
			key,
			at: found?.moment?.at ?? it.createdAt,
			suffix: found?.moment?.suffix ?? '',
			legacy: found?.alias ?? '',
			createdAt: it.createdAt,
			number: it.number,
			source: found ? 'legacy id' : 'creation time'
		});
	}
	todo.sort(
		(a, b) =>
			a.key.localeCompare(b.key) ||
			a.at.getTime() - b.at.getTime() ||
			(a.legacy ? 0 : 1) - (b.legacy ? 0 : 1) ||
			a.legacy.localeCompare(b.legacy) ||
			a.createdAt.getTime() - b.createdAt.getTime() ||
			a.number - b.number
	);

	const renames: Rename[] = [];
	for (const c of todo) {
		// If the old name already is an alias of another item, dropping it from the ref would point it at that item
		const owner = aliasOwner.get(c.ref.toUpperCase());
		if (owner && owner !== c.id) {
			skipped.push({
				id: c.id,
				ref: c.ref,
				reason: 'its old reference is an alias of another item'
			});
			continue;
		}
		const free = refCandidates(c.key, c.at, c.suffix).filter((v) => !occupied.has(v.toUpperCase()));
		if (!free.length) {
			skipped.push({ id: c.id, ref: c.ref, reason: 'every suffix of its minute is taken' });
			continue;
		}
		occupied.add(free[0].toUpperCase());
		renames.push({ id: c.id, projectId: c.projectId, from: c.ref, to: free[0], source: c.source });
	}
	return { orgId, renames, skipped, alreadyDone };
}

/**
 * Plans, and with `apply` makes, the renames of one org in one transaction. With `expected` it stops before the first update when the
 * plan no longer has that many renames (the data changed since the counts were shown). Any failure rolls the whole org back.
 */
export async function renameOrg(
	handle: DbHandle,
	orgId: string,
	options: { apply?: boolean; expected?: number } = {}
): Promise<OrgPlan & { applied: number }> {
	return withTenant(handle, { orgId }, async (tx) => {
		const plan = await planOrgRenames(tx, orgId);
		if (!options.apply) return { ...plan, applied: 0 };
		if (options.expected !== undefined && options.expected !== plan.renames.length)
			throw new Error(
				`The plan has ${plan.renames.length} renames now but ${options.expected} were shown. Nothing was changed. Run the dry run again.`
			);
		let applied = 0;
		for (const r of plan.renames) {
			const done = await tx
				.update(item)
				.set({ ref: r.to })
				.where(and(eq(item.id, r.id), eq(item.ref, r.from)))
				.returning({ id: item.id });
			if (done.length !== 1)
				throw new Error(`${r.from} was not renamed. Nothing in this org was changed.`);
			await tx
				.insert(itemAlias)
				.values({ orgId, projectId: r.projectId, itemId: r.id, alias: r.from })
				.onConflictDoNothing();
			applied++;
		}
		return { ...plan, applied };
	});
}
