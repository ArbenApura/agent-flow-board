// KEEPING A PLAN'S MOCKUPS IN STEP WITH THE PLAN: VISIBILITY AND THE PUBLIC LINK

// IMPORTED TYPES
import type { Tx } from './client';
// IMPORTED DEP-MODULES
import { eq, sql } from 'drizzle-orm';
// IMPORTED MODULES
import { mockup } from './schema';

// -- FUNCTIONS -- //

/**
 * The one helper every plan change calls: a plan's visibility change, Trash, undo and the importer. It copies the plan's
 * visibility to its mockups, and switches their public links off when the plan goes private or to the trash. A restore from
 * the trash never turns a link back on.
 */
export async function syncMockupsOfItem(
	tx: Tx,
	itemId: string,
	state: { visibility?: 'public' | 'private'; trashed?: boolean }
) {
	const linkOff = state.visibility === 'private' || state.trashed === true;
	const set: Partial<typeof mockup.$inferInsert> = {};
	if (state.visibility) set.visibility = state.visibility;
	if (linkOff) {
		set.publicEnabled = false;
		set.publicTokenHash = null;
	}
	if (Object.keys(set).length === 0) return;
	await tx
		.update(mockup)
		.set({ ...set, updatedAt: sql`now()`, version: sql`${mockup.version} + 1` })
		.where(eq(mockup.itemId, itemId));
}
