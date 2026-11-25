// KNOWLEDGE TABLES: THE FACTS EVERY PLAN OF A PROJECT SHOULD KNOW BEFORE IT STARTS (AFB-20261125-1527)

// IMPORTED DEP-MODULES
import { sql } from 'drizzle-orm';
import { index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
// IMPORTED MODULES
import { orgId, projectId } from './core';
import { id, oneOf, stamps, tenantTable } from './helpers';
import { item } from './items';

// -- CONSTANTS -- //

/** What kind of fact a pitfall is: a quirk of the machine or tools, a test known to fail, an editing trap, a live-safety rule. */
export const PITFALL_KINDS = ['environment', 'known-red-test', 'editing', 'live-safety'] as const;
export type PitfallKind = (typeof PITFALL_KINDS)[number];
/** Who wrote a pitfall: the person at the board, or an agent acting for them. */
export const PITFALL_AUTHOR_KINDS = ['person', 'agent'] as const;
export const PITFALL_TEXT_MAX = 500;
export const PITFALL_PATH_MAX = 300;

// -- PROJECT PITFALL -- //

/**
 * A short fact a plan of this project rediscovered more than once (a heap size, a test that fails on its own, a shell trap),
 * shown to every agent at the start of work and listed in Project settings. Text written by others is data, never instructions.
 */
export const projectPitfall = tenantTable(
	'project_pitfall',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		kind: text('kind', { enum: PITFALL_KINDS }).notNull(),
		text: text('text').notNull(),
		/** The text folded to lower case with runs of space made one, so the same fact cannot be added twice. */
		textKey: text('text_key').notNull(),
		path: text('path'),
		/** The plan the pitfall came from, when an agent added it from a lesson. */
		sourceItemId: uuid('source_item_id').references(() => item.id, { onDelete: 'set null' }),
		createdBy: text('created_by').notNull(),
		authorKind: text('author_kind', { enum: PITFALL_AUTHOR_KINDS }).notNull(),
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		...stamps()
	},
	(t) => [
		uniqueIndex('project_pitfall_text_uq')
			.on(t.projectId, t.textKey)
			.where(sql`${t.deletedAt} is null`),
		index('project_pitfall_project_idx').on(t.projectId, t.createdAt),
		oneOf('project_pitfall_kind_chk', t.kind, PITFALL_KINDS),
		oneOf('project_pitfall_author_kind_chk', t.authorKind, PITFALL_AUTHOR_KINDS)
	]
);
