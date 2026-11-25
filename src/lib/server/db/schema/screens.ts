// SCREEN TABLE: THE SCREENSHOTS OF A PLAN'S FINISHED SCREENS (AFB-20261124-0926; THE ANNOTATION TABLE WAS DROPPED IN AFB-20261125-0625)
// A screen is one picture of one changed screen of a plan, in one colour mode and at one width. The first capture is kept as
// the before picture and the latest as the after picture. Item privacy is not row level security: every verb reads the parent plan
// and applies the same visibility rule as the plan itself.

// IMPORTED DEP-MODULES
import { sql } from 'drizzle-orm';
import {
	bigint,
	check,
	index,
	integer,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
// IMPORTED MODULES
import { orgId, projectId } from './core';
import { item } from './items';
import { id, oneOf, tenantTable } from './helpers';

// -- CONSTANTS -- //

/** Every screenshot file lives under this prefix, so the general file route can refuse it. */
export const SCREEN_KEY_PREFIX = 'screens';
export const SCREEN_MODES = ['light', 'dark'] as const;
export const SCREEN_ROLES = ['before', 'after'] as const;
export type ScreenMode = (typeof SCREEN_MODES)[number];
export type ScreenRole = (typeof SCREEN_ROLES)[number];

// -- SCREEN -- //

export const screen = tenantTable(
	'screen',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		/** The plan it belongs to. The pictures go when the plan row is purged. */
		itemId: uuid('item_id')
			.notNull()
			.references(() => item.id, { onDelete: 'cascade' }),
		/** The phase key it shows, when the capture names one. */
		phaseKey: text('phase_key'),
		/** A short slug that names the screen across captures (for example 'settings-members'). */
		screenKey: text('screen_key').notNull(),
		mode: text('mode', { enum: SCREEN_MODES }).notNull(),
		width: integer('width').notNull(),
		role: text('role', { enum: SCREEN_ROLES }).notNull(),
		/** Written by the agent or a person, so it is untrusted text. */
		caption: text('caption').notNull().default(''),
		note: text('note').notNull().default(''),
		storageKey: text('storage_key').notNull(),
		size: bigint('size', { mode: 'number' }).notNull(),
		checksum: text('checksum').notNull(),
		createdBy: text('created_by'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		// One before and one after for each screen, mode and width, so first and latest cannot duplicate
		uniqueIndex('screen_slot_uq').on(t.itemId, t.screenKey, t.mode, t.width, t.role),
		uniqueIndex('screen_key_uq').on(t.storageKey),
		index('screen_item_idx').on(t.itemId),
		oneOf('screen_mode_chk', t.mode, SCREEN_MODES),
		oneOf('screen_role_chk', t.role, SCREEN_ROLES),
		check('screen_width_chk', sql`${t.width} between 200 and 4000`)
	]
);
