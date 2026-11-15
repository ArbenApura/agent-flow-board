// THE CONNECT A TOOL PAGE: WHAT EACH PERSON HAS DONE OR SKIPPED OF THE SETUP CHECKLIST (AFB-20261115-1000, H.3)

// IMPORTED DEP-MODULES
import { index, text, timestamp, unique } from 'drizzle-orm/pg-core';
// IMPORTED MODULES
import { orgId, user } from './core';
import { id, oneOf, tenantTable } from './helpers';

// -- CONSTANTS -- //

/** The six tiles of the checklist, and `panel` for whether the person folded it. A key outside this list is refused by the table. */
export const SETUP_KEYS = [
	'tools',
	'skills',
	'bridge',
	'editor',
	'checks',
	'token',
	'panel'
] as const;
/** done and skipped belong to a tile, open and closed to the panel. The verb keeps the two apart. */
export const SETUP_STATES = ['done', 'skipped', 'open', 'closed'] as const;

// -- SETUP MARKS -- //

/**
 * One row per person, organisation and tile. Personal: the row filter names the org and the person, and so does the check on a write,
 * so a person can neither read nor change another person's marks, and a row can never be moved to another organisation or person.
 * The things the board can know by itself (apps connected, the bridge sign in, a runner) are never stored here, only what the person said.
 */
export const connectSetupMark = tenantTable(
	'connect_setup_mark',
	'org',
	{
		id: id(),
		orgId: orgId(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		state: text('state').notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		unique('connect_setup_mark_uq').on(t.orgId, t.userId, t.key),
		index('connect_setup_mark_user_idx').on(t.userId, t.orgId),
		oneOf('connect_setup_mark_key_chk', t.key, SETUP_KEYS),
		oneOf('connect_setup_mark_state_chk', t.state, SETUP_STATES)
	],
	// The org wall and the person wall, on the read and on the write
	{
		using:
			"org_id = nullif(current_setting('app.org_id', true), '')::uuid and user_id = nullif(current_setting('app.user_id', true), '')",
		check:
			"org_id = nullif(current_setting('app.org_id', true), '')::uuid and user_id = nullif(current_setting('app.user_id', true), '')"
	}
);
