// TESTING TABLES: THE TEST CASES OF A PROJECT, THE RUNS AN AGENT MAKES, ONE RESULT PER CASE AND DEVICE, ITS PROOF PICTURES,
// THE CASES A PLAN ADOPTS AND THE SURFACES FOUND IN THE CODE (AFB-20261127-0438; THEY REPLACE THE QA MAP OF AFB-20261125-0442)
// A case is versioned: a plan that changes the behaviour writes a new version and the old one stays for the history. A run
// belongs to a plan. Item privacy is not row level security: every read joins a run to its plan and applies the same
// visibility rule as the plan itself. Proof files live in the same storage as screenshots, under their own prefix, and never
// in the backup archive.

// IMPORTED DEP-MODULES
import { sql } from 'drizzle-orm';
import {
	bigint,
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
import { id, oneOf, stamps, tenantTable, version } from './helpers';

// -- CONSTANTS -- //

/** Every proof file lives under this prefix, so the general file route can refuse it. */
export const TEST_PROOF_KEY_PREFIX = 'testproofs';
export const TEST_KINDS = ['ui', 'mcp', 'api', 'unit', 'skill'] as const;
export const TEST_PRIORITIES = ['high', 'normal', 'low'] as const;
export const TEST_STATUSES = ['pass', 'fail', 'blocked', 'not_run'] as const;
export const TEST_SEVERITIES = ['blocker', 'major', 'minor', 'cosmetic'] as const;
export const TEST_MODES = ['light', 'dark'] as const;
/** The board's own device sizes (SCREEN_WIDTH in src/lib/board/mockups.ts), plus a custom width and height. */
export const TEST_DEVICES = ['wide', 'laptop', 'tablet', 'phone', 'custom'] as const;
export const TEST_ROLES = ['reuse', 'update', 'new', 'retire'] as const;
export const TEST_RUN_STATES = ['open', 'finished', 'abandoned'] as const;
export const TEST_SURFACE_KINDS = ['route', 'mcp', 'api'] as const;
export type TestKind = (typeof TEST_KINDS)[number];
export type TestPriority = (typeof TEST_PRIORITIES)[number];
export type TestStatus = (typeof TEST_STATUSES)[number];
export type TestSeverity = (typeof TEST_SEVERITIES)[number];
export type TestMode = (typeof TEST_MODES)[number];
export type TestDevice = (typeof TEST_DEVICES)[number];
export type TestRole = (typeof TEST_ROLES)[number];
export type TestRunState = (typeof TEST_RUN_STATES)[number];
export type TestSurfaceKind = (typeof TEST_SURFACE_KINDS)[number];

// -- TYPES -- //

/** One step of a case: what the tester does. */
export type TestStep = { action: string };
/** One check of the expected result, typed so an agent can verify it from the page without judgement. */
export type TestCheck = {
	kind: 'text' | 'url' | 'element' | 'count' | 'clean' | 'visual';
	expect: string;
};
/** A device a UI case runs at: one of the board's four, or a custom size. */
export type TestDeviceSpec = { device: TestDevice; width: number; height: number };

// -- CASE -- //

export const testCase = tenantTable(
	'test_case',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		/** TC-<AREA>-<NN>, given by the server from the area counter. */
		key: text('key').notNull(),
		/** A / path (apps/centers/queue in a multi-app project, AUTH in a single one). */
		area: text('area').notNull(),
		kind: text('kind', { enum: TEST_KINDS }).notNull(),
		title: text('title').notNull(),
		priority: text('priority', { enum: TEST_PRIORITIES }).notNull().default('normal'),
		currentVersion: integer('current_version').notNull().default(1),
		retiredAt: timestamp('retired_at', { withTimezone: true }),
		/** The plan that retired it, so the sheet can say why it left the suite. */
		retiredBy: uuid('retired_by'),
		version: version(),
		...stamps()
	},
	(t) => [
		uniqueIndex('test_case_key_uq').on(t.projectId, t.key),
		index('test_case_area_idx').on(t.projectId, t.area),
		oneOf('test_case_kind_chk', t.kind, TEST_KINDS),
		oneOf('test_case_priority_chk', t.priority, TEST_PRIORITIES)
	]
);

// -- CASE VERSION -- //

export const testCaseVersion = tenantTable(
	'test_case_version',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		caseId: uuid('case_id')
			.notNull()
			.references(() => testCase.id, { onDelete: 'cascade' }),
		number: integer('number').notNull(),
		/** The plan that wrote this version. */
		planItemId: uuid('plan_item_id'),
		steps: jsonb('steps').$type<TestStep[]>().notNull().default([]),
		/** Names test accounts and sample values, never a password or a token (the redactor masks them on write). */
		inputData: text('input_data').notNull().default(''),
		checks: jsonb('checks').$type<TestCheck[]>().notNull().default([]),
		/** A unit or integration test this case reads its result from (file > name), for kind unit. */
		unitRef: text('unit_ref'),
		devices: jsonb('devices').$type<TestDeviceSpec[]>().notNull().default([]),
		/** The routes, MCP tools and API endpoints the case touches (route:/x, mcp:name, api:GET /x), for the coverage view. */
		surfaces: jsonb('surfaces').$type<string[]>().notNull().default([]),
		mode: text('mode', { enum: TEST_MODES }).notNull().default('light'),
		createdBy: text('created_by'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('test_case_version_uq').on(t.caseId, t.number),
		oneOf('test_case_version_mode_chk', t.mode, TEST_MODES)
	]
);

// -- COUNTER -- //

export const testCounter = tenantTable(
	'test_counter',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		/** The short area code in the key (AUTH, QUEUE), one counter each. */
		code: text('code').notNull(),
		/** The next number of the code, taken under a row lock. */
		next: integer('next').notNull().default(1)
	},
	(t) => [uniqueIndex('test_counter_uq').on(t.projectId, t.code)]
);

// -- RUN -- //

export const testRun = tenantTable(
	'test_run',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		/** The plan the run tests, when it has one (a sweep may run on none). The rows go when that plan is purged. */
		planItemId: uuid('plan_item_id').references(() => item.id, { onDelete: 'cascade' }),
		runNo: integer('run_no').notNull(),
		objective: text('objective').notNull().default(''),
		commit: text('commit').notNull().default(''),
		harness: text('harness').notNull().default(''),
		browser: text('browser').notNull().default(''),
		reviewer: text('reviewer').notNull().default(''),
		tier: text('tier').notNull().default(''),
		state: text('state', { enum: TEST_RUN_STATES }).notNull().default('open'),
		createdBy: text('created_by'),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
		/** The last result or heartbeat; an open run quiet for 30 minutes reads as abandoned. */
		lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp('finished_at', { withTimezone: true })
	},
	(t) => [
		uniqueIndex('test_run_no_uq').on(t.projectId, t.runNo),
		index('test_run_plan_idx').on(t.planItemId),
		oneOf('test_run_state_chk', t.state, TEST_RUN_STATES)
	]
);

// -- RESULT -- //

export const testResult = tenantTable(
	'test_result',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		runId: uuid('run_id')
			.notNull()
			.references(() => testRun.id, { onDelete: 'cascade' }),
		// A plain reference (no action): cases are retired and never hard deleted, and a restrict rule would fail the org purge
		caseId: uuid('case_id')
			.notNull()
			.references(() => testCase.id),
		caseVersion: integer('case_version').notNull(),
		/** The device it ran at; a non-UI case uses 'laptop' as its one slot. */
		device: text('device', { enum: TEST_DEVICES }).notNull(),
		width: integer('width').notNull(),
		height: integer('height').notNull(),
		mode: text('mode', { enum: TEST_MODES }).notNull(),
		status: text('status', { enum: TEST_STATUSES }).notNull(),
		/** Why it was blocked or not run, in a few words ("no browser", "sign-in needed"). */
		reason: text('reason').notNull().default(''),
		failedStep: integer('failed_step'),
		/** What happened. Agent text: untrusted, redacted on write. */
		actual: text('actual').notNull().default(''),
		/** The check output of a non-UI case, its proof. Redacted on write. */
		output: text('output').notNull().default(''),
		consoleLines: jsonb('console_lines').$type<string[]>().notNull().default([]),
		browser: text('browser').notNull().default(''),
		severity: text('severity', { enum: TEST_SEVERITIES }),
		bugPriority: text('bug_priority', { enum: TEST_PRIORITIES }),
		taskId: uuid('task_id').references(() => task.id, { onDelete: 'set null' }),
		createdBy: text('created_by'),
		...stamps()
	},
	(t) => [
		uniqueIndex('test_result_slot_uq').on(t.runId, t.caseId, t.device, t.width, t.height),
		index('test_result_case_idx').on(t.caseId, t.createdAt),
		oneOf('test_result_status_chk', t.status, TEST_STATUSES),
		oneOf('test_result_device_chk', t.device, TEST_DEVICES),
		oneOf('test_result_mode_chk', t.mode, TEST_MODES),
		check(
			'test_result_severity_chk',
			sql`${t.severity} is null or ${t.severity} in ('blocker', 'major', 'minor', 'cosmetic')`
		),
		check(
			'test_result_bug_priority_chk',
			sql`${t.bugPriority} is null or ${t.bugPriority} in ('high', 'normal', 'low')`
		),
		check(
			'test_result_size_chk',
			sql`${t.width} between 200 and 4000 and ${t.height} between 200 and 4000`
		)
	]
);

// -- PROOF -- //

export const testProof = tenantTable(
	'test_proof',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		resultId: uuid('result_id')
			.notNull()
			.references(() => testResult.id, { onDelete: 'cascade' }),
		/** The step it shows; null for the end state. */
		step: integer('step'),
		/** Null once the file is removed by the last-10 retention or was never restored; the row stays for the history. */
		storageKey: text('storage_key'),
		goneAt: timestamp('gone_at', { withTimezone: true }),
		mime: text('mime').notNull(),
		size: bigint('size', { mode: 'number' }).notNull(),
		checksum: text('checksum').notNull(),
		width: integer('width').notNull(),
		height: integer('height').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('test_proof_key_uq').on(t.storageKey),
		index('test_proof_result_idx').on(t.resultId)
	]
);

// -- PLAN CASES -- //

export const testPlanCase = tenantTable(
	'test_plan_case',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		planItemId: uuid('plan_item_id')
			.notNull()
			.references(() => item.id, { onDelete: 'cascade' }),
		caseId: uuid('case_id')
			.notNull()
			.references(() => testCase.id),
		role: text('role', { enum: TEST_ROLES }).notNull(),
		/** The case's result before the plan adopted it, never changed after the link is made. 'none' for a new case. */
		baseline: text('baseline').notNull().default('none'),
		linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('test_plan_case_uq').on(t.planItemId, t.caseId),
		index('test_plan_case_case_idx').on(t.caseId),
		oneOf('test_plan_case_role_chk', t.role, TEST_ROLES),
		check(
			'test_plan_case_baseline_chk',
			sql`${t.baseline} in ('none', 'pass', 'fail', 'blocked', 'not_run')`
		)
	]
);

// -- SURFACES -- //

export const testSurface = tenantTable(
	'test_surface',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		kind: text('kind', { enum: TEST_SURFACE_KINDS }).notNull(),
		/** A route path, an MCP tool name or a method and path. */
		key: text('key').notNull(),
		firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('test_surface_uq').on(t.projectId, t.kind, t.key),
		oneOf('test_surface_kind_chk', t.kind, TEST_SURFACE_KINDS)
	]
);
