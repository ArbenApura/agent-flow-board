// ITEM TABLES: ITEMS, ALIASES, PHASES, STEPS, CHECKS, DECISIONS, SECTIONS, TASKS, COMMENTS, ATTACHMENTS (SPEC 5)

// -- DEP-MODULES -- //
import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
// -- MODULES -- //
import { orgId, projectId, user } from './core';
import {
	STATUSES,
	STEP_STATES,
	VISIBILITIES,
	id,
	oneOf,
	stamps,
	tenantTable,
	tsvector,
	version
} from './helpers';

// -- TYPES -- //

export type ItemHealth = { flags: string[]; drift: string[] };
export type StepEvidence = {
	commit?: string;
	checkRunId?: string;
	target?: string;
	note?: string;
};

// -- ITEM -- //

export const item = tenantTable(
	'item',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		/** Per project number, from the locked project_counter row. */
		number: integer('number').notNull(),
		/** The readable reference, for example HAPR-142. Unique inside the org. */
		ref: text('ref').notNull(),
		title: text('title').notNull(),
		/** 1 to 3 words, UPPERCASE with underscores, at most 30 characters (SPEC 5). */
		tabName: text('tab_name'),
		stream: text('stream').notNull().default('features'),
		scope: text('scope').notNull().default('core'),
		status: text('status', { enum: STATUSES }).notNull().default('PLANNED'),
		visibility: text('visibility', { enum: VISIBILITIES }).notNull().default('public'),
		branchNote: text('branch_note'),
		assigneeId: text('assignee_id').references(() => user.id, { onDelete: 'set null' }),
		reviewerId: text('reviewer_id').references(() => user.id, { onDelete: 'set null' }),
		// Write-time calculated values (ADR-016)
		percent: integer('percent').notNull().default(0),
		doneSteps: integer('done_steps').notNull().default(0),
		totalSteps: integer('total_steps').notNull().default(0),
		openManual: integer('open_manual').notNull().default(0),
		health: jsonb('health')
			.$type<ItemHealth>()
			.notNull()
			.default(sql`'{"flags":[],"drift":[]}'::jsonb`),
		/** An imported item may keep a frozen percent instead of a calculated one (L18). */
		legacyPercent: integer('legacy_percent'),
		lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		deletedBy: text('deleted_by'),
		createdBy: text('created_by'),
		searchVector: tsvector('search_vector').generatedAlwaysAs(
			sql`to_tsvector('simple', coalesce(ref, '') || ' ' || coalesce(title, '') || ' ' || coalesce(tab_name, ''))`
		),
		...stamps(),
		version: version()
	},
	(t) => [
		unique('item_project_number_uq').on(t.projectId, t.number),
		unique('item_org_ref_uq').on(t.orgId, t.ref),
		index('item_project_status_idx').on(t.projectId, t.status),
		index('item_project_activity_idx').on(t.projectId, t.lastActivityAt),
		index('item_search_idx').using('gin', t.searchVector),
		oneOf('item_status_chk', t.status, STATUSES),
		oneOf('item_visibility_chk', t.visibility, VISIBILITIES)
	]
);

/** Old IDs that resolve to an item, only inside the caller's org (L15). */
export const itemAlias = tenantTable(
	'item_alias',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => item.id, { onDelete: 'cascade' }),
		alias: text('alias').notNull(),
		...stamps()
	},
	(t) => [
		unique('item_alias_org_alias_uq').on(t.orgId, t.alias),
		index('item_alias_item_idx').on(t.itemId)
	]
);

// -- PHASES, STEPS AND MANUAL CHECKS -- //

export const phase = tenantTable(
	'phase',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => item.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		title: text('title').notNull(),
		position: integer('position').notNull(),
		...stamps(),
		version: version()
	},
	(t) => [
		unique('phase_item_key_uq').on(t.itemId, t.key),
		index('phase_item_idx').on(t.itemId, t.position)
	]
);

export const step = tenantTable(
	'step',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => item.id, { onDelete: 'cascade' }),
		phaseId: uuid('phase_id')
			.notNull()
			.references(() => phase.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		text: text('text').notNull(),
		state: text('state', { enum: STEP_STATES }).notNull().default('open'),
		/** A pass counts only on this target (L25): dev, preview or deployed. */
		requiredTarget: text('required_target'),
		evidence: jsonb('evidence').$type<StepEvidence>(),
		reason: text('reason'),
		position: integer('position').notNull(),
		doneAt: timestamp('done_at', { withTimezone: true }),
		doneBy: text('done_by'),
		...stamps(),
		version: version()
	},
	(t) => [
		unique('step_item_key_uq').on(t.itemId, t.key),
		index('step_item_idx').on(t.itemId, t.position),
		index('step_phase_idx').on(t.phaseId),
		oneOf('step_state_chk', t.state, STEP_STATES)
	]
);

export const manualCheck = tenantTable(
	'manual_check',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => item.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		text: text('text').notNull(),
		auto: boolean('auto').notNull().default(false),
		state: text('state', { enum: STEP_STATES }).notNull().default('open'),
		reason: text('reason'),
		position: integer('position').notNull(),
		...stamps(),
		version: version()
	},
	(t) => [
		unique('manual_check_item_key_uq').on(t.itemId, t.key),
		oneOf('manual_check_state_chk', t.state, STEP_STATES)
	]
);

// -- DECISIONS AND SECTIONS -- //

export const decision = tenantTable(
	'decision',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => item.id, { onDelete: 'cascade' }),
		/** An ADR (adr) or a question settled without asking (settled), shown as the "Settled without asking" list. */
		kind: text('kind', { enum: ['adr', 'settled'] as const })
			.notNull()
			.default('adr'),
		number: integer('number').notNull(),
		title: text('title').notNull(),
		context: text('context').notNull().default(''),
		decision: text('decision').notNull().default(''),
		alternatives: text('alternatives').notNull().default(''),
		consequences: text('consequences').notNull().default(''),
		/** For a settled row, the answer and its source. */
		answer: text('answer'),
		source: text('source'),
		position: integer('position').notNull().default(0),
		searchVector: tsvector('search_vector').generatedAlwaysAs(
			sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(decision, '') || ' ' || coalesce(context, '') || ' ' || coalesce(answer, ''))`
		),
		...stamps(),
		version: version()
	},
	(t) => [
		index('decision_search_idx').using('gin', t.searchVector),
		unique('decision_item_kind_number_uq').on(t.itemId, t.kind, t.number),
		oneOf('decision_kind_chk', t.kind, ['adr', 'settled'])
	]
);

export const section = tenantTable(
	'section',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => item.id, { onDelete: 'cascade' }),
		/** spec, validation, references, as-built, resume-here, blockers or a custom document such as findings. */
		slug: text('slug').notNull(),
		title: text('title').notNull(),
		body: text('body').notNull().default(''),
		position: integer('position').notNull().default(0),
		searchVector: tsvector('search_vector').generatedAlwaysAs(
			sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))`
		),
		...stamps(),
		version: version()
	},
	(t) => [
		unique('section_item_slug_uq').on(t.itemId, t.slug),
		index('section_search_idx').using('gin', t.searchVector)
	]
);

// -- TASKS AND COMMENTS -- //

export const task = tenantTable(
	'task',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		number: integer('number').notNull(),
		title: text('title').notNull(),
		status: text('status').notNull().default('TODO'),
		/** Longer text of a task: what it asks, its links and its notes, as Markdown. Imported tasks carry it. */
		body: text('body').notNull().default(''),
		/** The heading a task is listed under, and its priority, when the source board had them. */
		groupName: text('group_name'),
		priority: text('priority'),
		assigneeId: text('assignee_id').references(() => user.id, { onDelete: 'set null' }),
		linkedItemIds: uuid('linked_item_ids')
			.array()
			.notNull()
			.default(sql`'{}'::uuid[]`),
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		searchVector: tsvector('search_vector').generatedAlwaysAs(
			sql`to_tsvector('simple', coalesce(title, ''))`
		),
		...stamps(),
		version: version()
	},
	(t) => [
		index('task_search_idx').using('gin', t.searchVector),
		unique('task_project_number_uq').on(t.projectId, t.number),
		oneOf('task_status_chk', t.status, ['TODO', 'IN PROGRESS', 'DONE', 'DROPPED', 'FUTURE'])
	]
);

export const comment = tenantTable(
	'comment',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		itemId: uuid('item_id').references(() => item.id, { onDelete: 'cascade' }),
		stepId: uuid('step_id').references(() => step.id, { onDelete: 'cascade' }),
		taskId: uuid('task_id').references(() => task.id, { onDelete: 'cascade' }),
		authorId: text('author_id'),
		body: text('body').notNull(),
		/** Guest written content reaches agents marked as untrusted (L3). */
		untrusted: boolean('untrusted').notNull().default(false),
		...stamps(),
		version: version()
	},
	(t) => [index('comment_item_idx').on(t.itemId, t.createdAt)]
);

// -- ATTACHMENTS -- //

export const attachment = tenantTable(
	'attachment',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		itemId: uuid('item_id').references(() => item.id, { onDelete: 'cascade' }),
		visibility: text('visibility', { enum: VISIBILITIES }).notNull().default('private'),
		caption: text('caption').notNull(),
		kind: text('kind').notNull(),
		refs: jsonb('refs')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		filename: text('filename').notNull(),
		mime: text('mime').notNull(),
		size: bigint('size', { mode: 'number' }).notNull(),
		checksum: text('checksum').notNull(),
		storageKey: text('storage_key').notNull(),
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		...stamps()
	},
	(t) => [
		index('attachment_item_idx').on(t.itemId),
		uniqueIndex('attachment_storage_key_uq').on(t.storageKey),
		oneOf('attachment_visibility_chk', t.visibility, VISIBILITIES)
	]
);
