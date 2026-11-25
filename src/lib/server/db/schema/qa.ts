// QA MAP TABLES: THE FEATURES OF A PROJECT'S APP, THE QA RUNS AN AGENT MAKES IN ITS OWN BROWSER, THEIR RESULTS AND BUGS (AFB-20261125-0442)
// A feature keeps its journeys, steps and cases as one map document, so a person edits a feature as a whole and the
// agent's rediscovery merges into it without overwriting what the person changed. A run is a normal plan item with one
// qa_run row; its results are rows of their own. Item privacy is not row level security: every read joins a result to its
// run item and applies the same visibility rule as the plan itself.

// IMPORTED DEP-MODULES
import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	jsonb,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
// IMPORTED MODULES
import { orgId, projectId } from './core';
import { item, task } from './items';
import { screen } from './screens';
import { id, oneOf, stamps, tenantTable, version } from './helpers';

// -- CONSTANTS -- //

export const QA_OUTCOMES = ['works', 'broken', 'could_not_test'] as const;
export const QA_BASELINES = ['works', 'broken', 'could_not_test', 'unknown'] as const;
export const QA_SEVERITIES = ['blocker', 'major', 'minor', 'cosmetic'] as const;
export const QA_PRIORITIES = ['high', 'normal', 'low'] as const;
export const QA_MODES = ['light', 'dark'] as const;
export type QaOutcome = (typeof QA_OUTCOMES)[number];
export type QaBaseline = (typeof QA_BASELINES)[number];
export type QaSeverity = (typeof QA_SEVERITIES)[number];
export type QaPriority = (typeof QA_PRIORITIES)[number];

// -- TYPES -- //

/** What a step is expected to do: what the screen shows, what is saved, what is sent and what is logged. */
export type QaExpected = { screen?: string; saved?: string; sent?: string; logged?: string };
/** One input row of a step: the data tried and what should happen with it. */
export type QaCase = {
	key: string;
	input: string;
	technique?: string;
	expected: string;
	/** A case in the regression set is rerun on every retest. */
	regression?: boolean;
	removedAt?: string;
};
export type QaStep = {
	key: string;
	page: string;
	action: string;
	control?: string;
	expected: QaExpected;
	cases: QaCase[];
	removedAt?: string;
};
export type QaJourney = {
	key: string;
	name: string;
	/** The step key of the main path this alternative path branches from. */
	parent?: string;
	steps: QaStep[];
	removedAt?: string;
};
export type QaMap = { journeys: QaJourney[] };
/** One place a test may run: an origin, and whether it holds throwaway data a run may write to. */
export type QaTarget = { origin: string; writes: boolean };
export type QaRunReport = {
	counts?: Record<string, number>;
	goNoGo?: 'go' | 'no-go';
	confidence?: string;
	summary?: string;
};
export type QaEntered = { field: string; value: string };

// -- FEATURE -- //

export const qaFeature = tenantTable(
	'qa_feature',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		/** A stable slug the agent and the case keys use across runs. */
		key: text('key').notNull(),
		area: text('area').notNull().default(''),
		name: text('name').notNull(),
		description: text('description').notNull().default(''),
		/** The person's call, never the agent's. */
		priority: text('priority', { enum: QA_PRIORITIES }),
		/** Files behind the feature, so a plan that touches them is linked to it. */
		codeGlobs: jsonb('code_globs').$type<string[]>().notNull().default([]),
		/** The screen widths tested, from the project type. */
		sizes: jsonb('sizes').$type<number[]>().notNull().default([]),
		map: jsonb('map').$type<QaMap>().notNull().default({ journeys: [] }),
		/** Paths a person edited (journey/step[/case].field). A merge never overwrites them. */
		editedPaths: jsonb('edited_paths').$type<string[]>().notNull().default([]),
		/** Notes left when a merge met a path the person edited. */
		conflicts: jsonb('conflicts').$type<string[]>().notNull().default([]),
		/** Set when a guest or a viewer edited the text, so an agent reads it as untrusted. */
		untrusted: boolean('untrusted').notNull().default(false),
		removedAt: timestamp('removed_at', { withTimezone: true }),
		/** The feature this one was merged into, kept so old results and links still resolve. */
		mergedInto: uuid('merged_into'),
		version: version(),
		...stamps()
	},
	(t) => [
		uniqueIndex('qa_feature_key_uq').on(t.projectId, t.key),
		index('qa_feature_project_idx').on(t.projectId),
		check(
			'qa_feature_priority_chk',
			sql`${t.priority} is null or ${t.priority} in ('high', 'normal', 'low')`
		)
	]
);

// -- SETTINGS -- //

export const qaSettings = tenantTable(
	'qa_settings',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		/** The places a run may target besides localhost:7174, set by an owner or an admin. */
		targets: jsonb('targets').$type<QaTarget[]>().notNull().default([]),
		/** The next run number of the project, taken under a row lock. */
		nextRun: integer('next_run').notNull().default(1),
		version: version(),
		...stamps()
	},
	(t) => [uniqueIndex('qa_settings_project_uq').on(t.projectId)]
);

// -- RUN -- //

export const qaRun = tenantTable(
	'qa_run',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		runNo: integer('run_no').notNull(),
		/** The run is an ordinary item; the row goes when that item is purged. */
		itemId: uuid('item_id')
			.notNull()
			.references(() => item.id, { onDelete: 'cascade' }),
		scope: text('scope').notNull().default(''),
		targetHost: text('target_host').notNull(),
		/** False when the target keeps real data: write cases are then Couldn't test. */
		writes: boolean('writes').notNull().default(false),
		commit: text('commit').notNull().default(''),
		sizes: jsonb('sizes').$type<number[]>().notNull().default([]),
		report: jsonb('report').$type<QaRunReport>().notNull().default({}),
		createdBy: text('created_by'),
		...stamps()
	},
	(t) => [
		uniqueIndex('qa_run_item_uq').on(t.itemId),
		uniqueIndex('qa_run_no_uq').on(t.projectId, t.runNo)
	]
);

// -- RESULT -- //

export const qaResult = tenantTable(
	'qa_result',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		runId: uuid('run_id')
			.notNull()
			.references(() => qaRun.id, { onDelete: 'cascade' }),
		/** The run item, kept on the row so every read can apply its visibility. */
		runItemId: uuid('run_item_id').notNull(),
		// A plain reference (no action): features are flagged removed and never hard deleted, and a restrict rule would
		// fail the org purge cascade
		featureId: uuid('feature_id')
			.notNull()
			.references(() => qaFeature.id),
		caseKey: text('case_key').notNull(),
		/** Given by the server, one higher for each try of the same case, width and mode in a run. */
		attempt: integer('attempt').notNull().default(1),
		outcome: text('outcome', { enum: QA_OUTCOMES }).notNull(),
		severity: text('severity', { enum: QA_SEVERITIES }),
		width: integer('width').notNull(),
		mode: text('mode', { enum: QA_MODES }).notNull(),
		role: text('role').notNull().default(''),
		targetHost: text('target_host').notNull(),
		/** What was seen: the proof of a Works, or what went wrong. Secrets are masked before it is written. */
		observed: text('observed').notNull().default(''),
		dataEntered: jsonb('data_entered').$type<QaEntered[]>().notNull().default([]),
		commit: text('commit').notNull().default(''),
		screenId: uuid('screen_id').references(() => screen.id, { onDelete: 'set null' }),
		taskId: uuid('task_id').references(() => task.id, { onDelete: 'set null' }),
		sessionId: text('session_id'),
		redactedAt: timestamp('redacted_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('qa_result_try_uq').on(t.runId, t.caseKey, t.width, t.mode, t.attempt),
		index('qa_result_feature_idx').on(t.featureId, t.createdAt),
		index('qa_result_run_idx').on(t.runId),
		oneOf('qa_result_outcome_chk', t.outcome, QA_OUTCOMES),
		oneOf('qa_result_mode_chk', t.mode, QA_MODES),
		check(
			'qa_result_severity_chk',
			sql`${t.severity} is null or ${t.severity} in ('blocker', 'major', 'minor', 'cosmetic')`
		),
		check('qa_result_width_chk', sql`${t.width} between 200 and 4000`)
	]
);

// -- PLAN LINKS -- //

export const qaPlanFeature = tenantTable(
	'qa_plan_feature',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		planItemId: uuid('plan_item_id')
			.notNull()
			.references(() => item.id, { onDelete: 'cascade' }),
		featureId: uuid('feature_id')
			.notNull()
			.references(() => qaFeature.id),
		/** The feature's result before the plan started building; it never changes after the link is made. */
		baselineOutcome: text('baseline_outcome', { enum: QA_BASELINES }).notNull().default('unknown'),
		baselineAt: timestamp('baseline_at', { withTimezone: true }).notNull().defaultNow(),
		/** The first time the plan moved to IN REVIEW, so a result older than it means Needs retest. */
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('qa_plan_feature_uq').on(t.planItemId, t.featureId),
		index('qa_plan_feature_feature_idx').on(t.featureId),
		oneOf('qa_plan_feature_baseline_chk', t.baselineOutcome, QA_BASELINES)
	]
);

// -- BUGS -- //

export const qaBug = tenantTable(
	'qa_bug',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		/** A hash of the feature, the page and the shape of what went wrong: one cause, one bug. */
		causeKey: text('cause_key').notNull(),
		taskId: uuid('task_id')
			.notNull()
			.references(() => task.id, { onDelete: 'cascade' }),
		featureId: uuid('feature_id')
			.notNull()
			.references(() => qaFeature.id),
		...stamps()
	},
	(t) => [
		uniqueIndex('qa_bug_cause_uq').on(t.projectId, t.causeKey),
		index('qa_bug_task_idx').on(t.taskId)
	]
);
