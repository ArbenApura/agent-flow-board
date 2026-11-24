// SCREEN TABLES: THE SCREENSHOTS OF A PLAN'S FINISHED SCREENS AND THE ANNOTATIONS DRAWN OVER THEM (AFB-20261124-0926)
// A screen is one picture of one changed screen of a plan, in one colour mode and at one width. The first capture is kept as
// the before picture and the latest as the after picture. Item privacy is not row level security: every verb reads the parent plan
// and applies the same visibility rule as the plan itself.

// IMPORTED DEP-MODULES
import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	real,
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
/** A pin is a point; a box is a rectangle from (x, y) of size (w, h); an arrow runs from (x, y) to (x + w, y + h). */
export const ANNOTATION_KINDS = ['pin', 'box', 'arrow'] as const;
export type ScreenMode = (typeof SCREEN_MODES)[number];
export type ScreenRole = (typeof SCREEN_ROLES)[number];
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

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

// -- ANNOTATIONS -- //

export const screenAnnotation = tenantTable(
	'screen_annotation',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		screenId: uuid('screen_id')
			.notNull()
			.references(() => screen.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: ANNOTATION_KINDS }).notNull(),
		/** Fractions of the picture, 0 to 1, measured from its top left corner. */
		x: real('x').notNull(),
		y: real('y').notNull(),
		/** Size of a box, or the offset of an arrow's end (may be negative). Null for a pin. */
		w: real('w'),
		h: real('h'),
		body: text('body').notNull(),
		authorId: text('author_id'),
		author: text('author').notNull().default(''),
		/** Written by a guest or a viewer, so an agent reads it as untrusted. */
		untrusted: boolean('untrusted').notNull().default(false),
		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
		resolvedBy: text('resolved_by'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('screen_annotation_screen_idx').on(t.screenId),
		oneOf('screen_annotation_kind_chk', t.kind, ANNOTATION_KINDS),
		check('screen_annotation_xy_chk', sql`${t.x} between 0 and 1 and ${t.y} between 0 and 1`),
		check(
			'screen_annotation_wh_chk',
			sql`(${t.w} is null or ${t.w} between -1 and 1) and (${t.h} is null or ${t.h} between -1 and 1)`
		)
	]
);
