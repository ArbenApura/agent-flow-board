// SAVES THE "CONTINUE WITH" CHOICE OF A PERSON. ONLY THESE TWO COLUMNS CHANGE, SO THE LIGHT AND DARK CHOICE AND THE OTHER PREFERENCES STAY AS THEY ARE

// IMPORTED DEP-MODULES
import { sql } from 'drizzle-orm';
// IMPORTED MODULES
import { getDb } from '../db/index.js';
import { userPref } from '../db/schema/index.js';
import { withTenant } from '../db/tenant.js';

// -- FUNCTIONS -- //

/** Writes the person's own row inside their own context, like the light and dark choice does. */
export async function saveContinueChoice(
	userId: string,
	choice: { continueTool: string; continueMode: string }
) {
	await withTenant(await getDb(), { userId }, (tx) =>
		tx
			.insert(userPref)
			.values({ userId, ...choice })
			.onConflictDoUpdate({
				target: userPref.userId,
				set: { ...choice, updatedAt: sql`now()` }
			})
	);
}
