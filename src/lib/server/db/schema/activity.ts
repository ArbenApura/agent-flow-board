// ACTIVITY TABLES: EVENT LOG, SESSIONS, IDEMPOTENCY LOG, COMMIT LINKS (SPEC 5, 7 AND 9)

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
import { orgId, projectId } from './core';
import { item } from './items';
import { id, stamps, tenantTable } from './helpers';

// -- TYPES -- //

export type Patch = Record<string, unknown> | null;

export const WAITING_KINDS = ['sign-in', 'approval', 'decision'] as const;
export type WaitingKind = (typeof WAITING_KINDS)[number];
export type WaitingBlocker = {
	kind: WaitingKind;
	detail: string;
	target?: string;
	setAt: string;
};

// -- EVENT (APPEND ONLY) -- //

export const event = tenantTable(
	'event',
	'project',
	{
		/** A sequence, so a reconnecting page can ask for everything after the last id it saw. */
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		orgId: orgId(),
		projectId: projectId(),
		// No foreign key: the log outlives the item, so purging an old trashed item never touches history
		itemId: uuid('item_id'),
		/** Anonymised when a user is deleted (L19); no other column ever changes. */
		actorUserId: text('actor_user_id'),
		actorLabel: text('actor_label'),
		tool: text('tool'),
		tokenId: uuid('token_id'),
		sessionId: text('session_id'),
		verb: text('verb').notNull(),
		targetType: text('target_type').notNull(),
		targetId: text('target_id'),
		before: jsonb('before').$type<Patch>(),
		after: jsonb('after').$type<Patch>(),
		/** An event that reverses another event (compensating undo, L17). */
		undoOf: bigint('undo_of', { mode: 'number' }),
		/** Whether the change can be undone from the board, or reached outside the database (L14). */
		undoable: boolean('undoable').notNull().default(true),
		external: boolean('external').notNull().default(false),
		requestId: text('request_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('event_project_idx').on(t.projectId, t.id),
		index('event_item_idx').on(t.itemId, t.id),
		index('event_session_idx').on(t.sessionId, t.id),
		// Finds the event that undid another one (history rows, undo conflict checks) without scanning the whole log
		index('event_undo_of_idx')
			.on(t.undoOf)
			.where(sql`${t.undoOf} is not null`)
	],
	{ appendOnly: true }
);

// -- SESSION (AN AGENT SESSION, ID MINTED BY session_start, ADR-022) -- //

export const session = tenantTable(
	'session',
	'org',
	{
		id: text('id').primaryKey(),
		orgId: orgId(),
		userId: text('user_id').notNull(),
		tokenId: uuid('token_id'),
		tool: text('tool').notNull(),
		claimedItemId: uuid('claimed_item_id').references(() => item.id, { onDelete: 'set null' }),
		claimedPhase: text('claimed_phase'),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
		/** The last code change this session recorded against its item, for the reminder rule. */
		recordedState: jsonb('recorded_state')
			.notNull()
			.default(sql`'{}'::jsonb`),
		/** Set when the session was already asked to bind, or its claim was released by a close (L38). */
		askedAt: timestamp('asked_at', { withTimezone: true }),
		titleSent: text('title_sent'),
		label: text('label'),
		/** The tool's own id for the conversation (a hook payload names it), so hook calls find their session again. */
		externalId: text('external_id'),
		/** The last time this session changed code, and the last time it was reminded to record (SPEC 9.3). */
		codeTouchedAt: timestamp('code_touched_at', { withTimezone: true }),
		remindedAt: timestamp('reminded_at', { withTimezone: true }),
		/** The last time this session recorded a step, so an idle claim can be told from a busy one. */
		lastRecordAt: timestamp('last_record_at', { withTimezone: true }),
		/** Code edits since the last recorded step, the time of the first one, and the nudge level already sent for them. */
		codeEditsSinceRecord: integer('code_edits_since_record').notNull().default(0),
		firstUnrecordedEditAt: timestamp('first_unrecorded_edit_at', { withTimezone: true }),
		nudgedLevel: integer('nudged_level').notNull().default(0),
		/** Messages for the session's next reply: a claim released because its item closed, for example. */
		notices: jsonb('notices')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** First-class waiting-for-a-person blocker (sign-in, approval, decision), cleared when resolved or claim released. */
		waiting: jsonb('waiting').$type<WaitingBlocker | null>(),
		...stamps()
	},
	(t) => [
		index('session_item_idx').on(t.claimedItemId),
		index('session_user_idx').on(t.userId, t.lastSeenAt),
		uniqueIndex('session_external_uq')
			.on(t.orgId, t.userId, t.tool, t.externalId)
			.where(sql`${t.externalId} is not null`)
	]
);

// -- SESSION EVENT (APPEND ONLY: WHEN A SESSION CLAIMED, RELEASED, WAS REMINDED, NUDGED OR ENDED) -- //

export const sessionEvent = tenantTable(
	'session_event',
	'org',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		orgId: orgId(),
		// No foreign keys: the history outlives the session row and the item
		sessionId: text('session_id').notNull(),
		itemId: uuid('item_id'),
		tool: text('tool'),
		/** claim, release, stop_reminder, nudge or end. */
		kind: text('kind').notNull(),
		detail: text('detail'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('session_event_item_idx').on(t.itemId, t.id),
		index('session_event_session_idx').on(t.sessionId, t.id)
	],
	{ appendOnly: true }
);

// -- REQUEST LOG (IDEMPOTENCY, ADR OF PHASE 5) -- //

export const requestLog = tenantTable(
	'request_log',
	'org',
	{
		id: id(),
		orgId: orgId(),
		/** The token, session or user that made the call. */
		actor: text('actor').notNull(),
		requestId: text('request_id').notNull(),
		result: jsonb('result').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [unique('request_log_uq').on(t.orgId, t.actor, t.requestId)]
);

export const rateBucket = tenantTable(
	'rate_bucket',
	'org',
	{
		id: id(),
		orgId: orgId(),
		/** A token or user, and the window start, so one row counts one window. */
		actor: text('actor').notNull(),
		windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
		count: integer('count').notNull().default(0)
	},
	(t) => [unique('rate_bucket_uq').on(t.orgId, t.actor, t.windowStart)]
);

// -- MCP CALL TIMING (ONE ROW PER MCP CALL: TOOL, DURATION, OUTCOME; NEVER A PAYLOAD) -- //

export const mcpCallTiming = tenantTable(
	'mcp_call_timing',
	'org',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		orgId: orgId(),
		// No foreign key and nullable: a call such as session_start belongs to no project, and the log outlives a deleted project
		projectId: uuid('project_id'),
		/** The tool name, taken from the fixed tool registry. */
		tool: text('tool').notNull(),
		durationMs: integer('duration_ms').notNull(),
		/** ok, or the error code (INVALID, NOT_FOUND, ...). Never the message: it can quote what a person wrote. */
		outcome: text('outcome').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('mcp_call_timing_project_idx').on(t.orgId, t.projectId, t.durationMs),
		index('mcp_call_timing_created_idx').on(t.orgId, t.createdAt)
	]
);
