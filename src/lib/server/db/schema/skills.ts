// CUSTOM SKILLS: A PROJECT OR ORGANISATION SKILL SERVED TO AGENTS, AND ITS APPEND ONLY REVISIONS (SPEC 5, ADR SKILLS 1-6)
// A skill is text every agent obeys, so the row carries its content hash, its author and the revision number it is at.
// The org scope is carried from day one: a project skill has a project, an organisation skill does not.

// -- DEP-MODULES -- //
import { sql } from 'drizzle-orm';
import { index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
// -- MODULES -- //
import { orgId, project, user } from './core';
import { id, stamps, tenantTable, version } from './helpers';

// -- SKILL -- //

/** Org-level rows stay visible when a project is set: the project wall narrows project rows only. */
const SKILL_VISIBILITY = `"org_id" = nullif(current_setting('app.org_id', true), '')::uuid and ("project_id" is null or nullif(current_setting('app.project_id', true), '') is null or "project_id" = nullif(current_setting('app.project_id', true), '')::uuid)`;

export const skill = tenantTable(
	'skill',
	'project',
	{
		id: id(),
		orgId: orgId(),
		/** Null for an organisation skill, set for a project skill. */
		projectId: uuid('project_id').references(() => project.id, { onDelete: 'cascade' }),
		/** Lowercase slug, unique among the live skills of its scope, never a built-in name (ADR SKILLS 1). */
		name: text('name').notNull(),
		/** One line a person reads in project_rules. */
		summary: text('summary').notNull(),
		/** The skill text as it is served, at most 100,000 characters. */
		body: text('body').notNull(),
		/** SHA-256 over the name, the summary and the body (the bridge reuses it for drift detection). */
		hash: text('hash').notNull(),
		/** The newest revision number of this skill. */
		revision: integer('revision').notNull().default(1),
		authorId: text('author_id').references(() => user.id, { onDelete: 'set null' }),
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		...stamps(),
		version: version()
	},
	(t) => [
		// One live name per project, and one per organisation scope. A deleted skill frees its name
		uniqueIndex('skill_project_name_uq')
			.on(t.projectId, t.name)
			.where(sql`deleted_at is null and project_id is not null`),
		uniqueIndex('skill_org_name_uq')
			.on(t.orgId, t.name)
			.where(sql`deleted_at is null and project_id is null`),
		index('skill_project_idx').on(t.projectId, t.name),
		index('skill_org_idx').on(t.orgId, t.name)
	],
	{ using: SKILL_VISIBILITY, check: SKILL_VISIBILITY }
);

// -- SKILL REVISIONS -- //

/**
 * Every save keeps the text it replaced. Rows only ever grow: the runtime role may read and insert, never change or delete
 * one, so a revision cannot be rewritten after the fact. The project id mirrors the skill's, so the project wall applies.
 */
export const skillRevision = tenantTable(
	'skill_revision',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: uuid('project_id').references(() => project.id, { onDelete: 'cascade' }),
		skillId: uuid('skill_id')
			.notNull()
			.references(() => skill.id, { onDelete: 'cascade' }),
		revision: integer('revision').notNull(),
		name: text('name').notNull(),
		summary: text('summary').notNull(),
		body: text('body').notNull(),
		hash: text('hash').notNull(),
		authorId: text('author_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('skill_revision_skill_revision_uq').on(t.skillId, t.revision),
		index('skill_revision_skill_idx').on(t.skillId, t.revision)
	],
	{ using: SKILL_VISIBILITY, check: SKILL_VISIBILITY, appendOnly: true }
);
