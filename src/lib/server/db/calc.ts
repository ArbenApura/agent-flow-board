// WRITE TIME CALCULATED VALUES: PERCENT, COUNTS AND DRIFT FLAGS ARE UPDATED IN THE SAME TRANSACTION AS THE CHANGE (ADR-016)
// The item row is locked first (SELECT ... FOR UPDATE), so two concurrent step changes cannot lose an update.

// -- TYPES -- //
import type { Tx } from './client';
import type { ItemHealth } from './schema';
// -- DEP-MODULES -- //
import { and, eq, inArray, sql } from 'drizzle-orm';
// -- MODULES -- //
import { computeVisualProgress } from '../../shared/progress';
import { item, manualCheck, step } from './schema';

// -- TYPES -- //

export type Counts = { total: number; done: number; openManual: number };
export type DriftInput = { status: string; legacy: boolean } & Counts;

// -- FUNCTIONS -- //

/** Done over counted steps (open and done), rounded down. "n/a" is stored as 0 with total 0, shown by the UI. */
export function percentOf(total: number, done: number): number {
	return total === 0 ? 0 : Math.floor((done / total) * 100);
}

/**
 * Drift warnings of SPEC 9.4 that depend only on the item itself. They never block anything.
 * The warning for a plan with questions but no "Settled
 * without asking" list is not built, because an item holds no record of its open questions to count.
 */
export function driftFlags(i: DriftInput): string[] {
	if (i.legacy) return [];
	const out: string[] = [];
	const complete = i.total > 0 && i.done === i.total;
	if (i.status === 'PLANNED' && i.done > 0) out.push('planned-with-done-steps');
	if (i.status === 'IN PROGRESS' && complete) out.push('complete-not-in-review');
	if (i.status === 'IN REVIEW' && i.done < i.total) out.push('in-review-with-open-steps');
	if (i.status === 'IN REVIEW' && complete && i.openManual === 0) out.push('ready-for-sign-off');
	return out;
}

/** Locks the item row until the transaction ends. Every change to its steps takes this first. */
export async function lockItem(tx: Tx, itemId: string) {
	const rows = await tx.select().from(item).where(eq(item.id, itemId)).for('update');
	if (!rows[0]) throw new Error('Item not found');
	return rows[0];
}

/** Counts from the step and check tables, never from a cached value. */
export async function countsFor(tx: Tx, itemId: string): Promise<Counts> {
	const [s] = await tx
		.select({
			total: sql<number>`count(*) filter (where ${step.state} in ('open', 'done'))::int`,
			done: sql<number>`count(*) filter (where ${step.state} = 'done')::int`
		})
		.from(step)
		.where(eq(step.itemId, itemId));
	const [m] = await tx
		.select({ open: sql<number>`count(*)::int` })
		.from(manualCheck)
		.where(and(eq(manualCheck.itemId, itemId), inArray(manualCheck.state, ['open'])));
	return { total: s.total, done: s.done, openManual: m.open };
}

/** Computes health flags, drift warnings, and honest visual-progress summary for one item. */
export async function computeHealthForItem(
	tx: Tx,
	itemId: string,
	status: string,
	legacyPercent: number | null,
	existingFlags: string[] = [],
	counts?: Counts
): Promise<ItemHealth> {
	const c = counts ?? (await countsFor(tx, itemId));
	const legacy = legacyPercent !== null;
	const stepRows = legacy
		? []
		: await tx
				.select({
					state: step.state,
					visible: step.visible,
					visibleInferred: step.visibleInferred,
					evidence: step.evidence
				})
				.from(step)
				.where(eq(step.itemId, itemId));
	const visProg = computeVisualProgress(stepRows, { legacyPercent, status });
	const cleanFlags = existingFlags.filter((f) => f !== 'unverified-visually');
	const flags = visProg.unverifiedVisually ? [...cleanFlags, 'unverified-visually'] : cleanFlags;
	return {
		flags,
		drift: driftFlags({ status, legacy, ...c }),
		verifiedPercent: visProg.verifiedPercent,
		visibleTotal: visProg.visibleTotal,
		visibleVerified: visProg.visibleVerified
	};
}

/** Recomputes and stores percent, counts and drift flags. Call it inside the transaction that changed a step or check. */
export async function recalcItem(tx: Tx, itemId: string) {
	const locked = await lockItem(tx, itemId);
	const counts = await countsFor(tx, itemId);
	const legacy = locked.legacyPercent !== null;
	const percent = legacy ? (locked.legacyPercent as number) : percentOf(counts.total, counts.done);
	const health = await computeHealthForItem(
		tx,
		itemId,
		locked.status,
		locked.legacyPercent,
		locked.health.flags,
		counts
	);
	const [updated] = await tx
		.update(item)
		.set({
			percent,
			doneSteps: counts.done,
			totalSteps: counts.total,
			openManual: counts.openManual,
			health,
			lastActivityAt: sql`now()`,
			updatedAt: sql`now()`,
			version: sql`${item.version} + 1`
		})
		.where(eq(item.id, itemId))
		.returning();
	return { item: updated, counts, percent };
}
