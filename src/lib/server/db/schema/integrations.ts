// INTEGRATION TABLES: BROWSER CHECKS, UI SHOTS, RUNNERS, SECRETS, BACKUPS, TOKENS AND CONNECTIONS (SPEC 5, 6, 8 AND 10)

// -- DEP-MODULES -- //
import { sql } from 'drizzle-orm';
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
// -- MODULES -- //
import { orgId, projectId, user } from './core';
import { item } from './items';
import { TARGETS, id, oneOf, stamps, tenantTable, version } from './helpers';

// -- TYPES -- //

export type UiFlag = {
	level: string;
	kind: string;
	text: string;
	page?: string;
	theme?: string;
	viewport?: number;
};
/** One measured page: what it showed in one theme and width, the values read, the picture, and the sibling's values. */
export type ShotResult = {
	/** The id of the ui_change row this measures. */
	row?: string;
	page: string;
	state: string;
	theme: string;
	viewport: number;
	side: 'before' | 'after' | 'sibling';
	values: Levels;
	/** The attachment id of the picture, once stored. */
	image?: string;
	of?: string;
};
export const RUN_STATES = [
	'queued',
	'running',
	'done',
	'failed',
	'timeout',
	'unavailable'
] as const;
export type Levels = Record<string, Record<string, number | number[]>>;

// -- BROWSER CHECKS -- //

/** One registration the afb-checks tool holds, as it reports it: the board project key it serves, its name, and the folder name and branch of its repo. */
export type ToolRegistration = { project: string; name: string; repo?: string; branch?: string };

export const check = tenantTable(
	'check',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => item.id, { onDelete: 'cascade' }),
		manualKey: text('manual_key').notNull(),
		script: text('script').notNull(),
		coveredPaths: jsonb('covered_paths')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		requiredTarget: text('required_target', { enum: TARGETS }).notNull().default('preview'),
		/** When set, the check always runs on this target unless a run names another (SPEC 10 target choice order). */
		pinnedTarget: text('pinned_target', { enum: TARGETS }),
		/** The afb-checks registration this check runs in (a name the tool holds for the project). Null means the project's only registration; a run may name another. */
		registration: text('registration'),
		...stamps(),
		version: version()
	},
	(t) => [
		unique('check_item_key_uq').on(t.itemId, t.manualKey),
		oneOf('check_target_chk', t.requiredTarget, TARGETS)
	]
);

export const checkRun = tenantTable(
	'check_run',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		checkId: uuid('check_id')
			.notNull()
			.references(() => check.id, { onDelete: 'cascade' }),
		target: text('target', { enum: TARGETS }).notNull(),
		url: text('url'),
		commit: text('commit'),
		diffHash: text('diff_hash'),
		durationMs: integer('duration_ms'),
		result: text('result').notNull(),
		flaky: boolean('flaky').notNull().default(false),
		evidence: jsonb('evidence')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** Who asked, and the target they asked for (the run may report a different one only as unavailable). */
		requestedBy: text('requested_by'),
		requestedTarget: text('requested_target'),
		/** The plan step this run was started for. A pass on its required target ticks it. */
		stepKey: text('step_key'),
		/** The registration this run was asked to use (null: any the tool can choose, which is its only one). */
		registration: text('registration'),
		/** What the tool reports it used: the registration, the folder name of its repo and its branch. A pass from another registration than the one asked for is an error. */
		ranRegistration: text('ran_registration'),
		ranRepo: text('ran_repo'),
		ranBranch: text('ran_branch'),
		runnerId: uuid('runner_id'),
		startedAt: timestamp('started_at', { withTimezone: true }),
		/** The last time the runner holding this run said it is alive. A tool run with no beat for ten minutes is reported stuck. */
		lastBeatAt: timestamp('last_beat_at', { withTimezone: true }),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		/** Why a run failed, timed out or was unavailable, with the next target offered. Never holds a secret. */
		reason: text('reason'),
		/** The masked tail of the run log. */
		log: text('log'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('check_run_check_idx').on(t.checkId, t.createdAt),
		oneOf('check_run_result_chk', t.result, [
			'queued',
			'running',
			'pass',
			'fail',
			'timeout',
			'error',
			'unavailable'
		])
	]
);

// -- UI SHOTS AND DESIGN FIT (SPEC 10.1) -- //
// The UI shots feature was removed: nothing reads or writes these three tables any more (browser checks carry the screenshots).
// They are kept so no migration drops live rows; a later migration may drop them.

export const uiChange = tenantTable(
	'ui_change',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		itemId: uuid('item_id')
			.notNull()
			.references(() => item.id, { onDelete: 'cascade' }),
		page: text('page').notNull(),
		/** The state recipe: click:, wait: and scroll: steps joined by " > ", or empty for none. Opening only. */
		stateRecipe: text('state_recipe').notNull().default(''),
		themes: text('themes')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		accounts: text('accounts').notNull().default('default'),
		siblings: text('siblings')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		levels: text('levels')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		viewports: integer('viewports')
			.array()
			.notNull()
			.default(sql`'{}'::integer[]`),
		position: integer('position').notNull().default(0),
		...stamps(),
		version: version()
	},
	(t) => [index('ui_change_item_idx').on(t.itemId, t.position)]
);

export const uiShotRun = tenantTable(
	'ui_shot_run',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		/** A measure job belongs to the project, not to an item. */
		itemId: uuid('item_id').references(() => item.id, { onDelete: 'cascade' }),
		kind: text('kind', { enum: ['shots', 'measure'] as const })
			.notNull()
			.default('shots'),
		state: text('state', { enum: RUN_STATES }).notNull().default('queued'),
		requestedBy: text('requested_by'),
		runnerId: uuid('runner_id'),
		target: text('target'),
		/** The Capture screens button asks for fresh pictures even when nothing changed; an agent's own request does not, so an unchanged tree is not built twice. */
		force: boolean('force').notNull().default(false),
		beforeTarget: text('before_target'),
		beforeCommit: text('before_commit'),
		afterCommit: text('after_commit'),
		diffHash: text('diff_hash'),
		/** The changed paths of the working tree, and which of them belong to other people's work. */
		changedPaths: jsonb('changed_paths')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		foreignPaths: jsonb('foreign_paths')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** One entry per page, state, theme and viewport: the measured values, the pictures and the sibling values. */
		results: jsonb('results')
			.$type<ShotResult[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		flags: jsonb('flags')
			.$type<UiFlag[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		imageAttachmentIds: jsonb('image_attachment_ids')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** Calls the pages made to other addresses, counted and never followed, and writes that were aborted. */
		outsideCalls: integer('outside_calls').notNull().default(0),
		abortedWrites: integer('aborted_writes').notNull().default(0),
		reason: text('reason'),
		startedAt: timestamp('started_at', { withTimezone: true }),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('ui_shot_run_item_idx').on(t.itemId, t.createdAt),
		index('ui_shot_run_project_idx').on(t.projectId, t.createdAt),
		oneOf('ui_shot_run_state_chk', t.state, RUN_STATES)
	]
);

export const designScale = tenantTable(
	'design_scale',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		theme: text('theme').notNull(),
		viewport: integer('viewport').notNull(),
		levels: jsonb('levels').$type<Levels>().notNull(),
		seenOn: jsonb('seen_on')
			.$type<Record<string, number>>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		runId: uuid('run_id'),
		...stamps()
	},
	(t) => [unique('design_scale_uq').on(t.projectId, t.theme, t.viewport)]
);

// -- RUNNERS, ENVIRONMENTS AND SECRETS (SPEC 10) -- //

export const runner = tenantTable(
	'runner',
	'org',
	{
		id: id(),
		orgId: orgId(),
		kind: text('kind', { enum: ['local', 'hosted', 'tool'] as const }).notNull(),
		name: text('name').notNull(),
		ownerId: text('owner_id').references(() => user.id, { onDelete: 'set null' }),
		projectIds: uuid('project_ids')
			.array()
			.notNull()
			.default(sql`'{}'::uuid[]`),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
		tokenHash: text('token_hash'),
		/**
		 * The head of the tool's local audit chain and its length, as the tool last reported them (only the hash and a count, never an action or a path).
		 * A report that is shorter than the last one, or as long with another head, means the local log was cut or rewritten: audit_regressed_at records when.
		 */
		auditHead: text('audit_head'),
		auditLines: integer('audit_lines'),
		auditRegressedAt: timestamp('audit_regressed_at', { withTimezone: true }),
		/**
		 * How many runs the tool takes at once and how many it holds, as it last reported them in a header (two small numbers, display only, never used to schedule).
		 * Null for a runner that reports none.
		 */
		capacitySlots: integer('capacity_slots'),
		capacityBusy: integer('capacity_busy'),
		/**
		 * The registrations the tool holds, as it last reported them in a header: [{ project, name, repo, branch }] with only plain names (a board project key, a registration name, the folder name of its repo and its branch).
		 * A run that names a registration is taken only by a tool that lists it. Null for a runner that reports none (an older tool), which then takes only runs that name none.
		 */
		registrations: jsonb('registrations').$type<ToolRegistration[] | null>(),
		/**
		 * The public key a tool publishes so the board can encrypt a test account's sign in to this machine (AFB-20261108-1444). Only the tool's own runner token sets it.
		 * The key id names the key pair; the public key is the base64url of its raw uncompressed P-256 point. Nothing private is ever stored here.
		 */
		signinKeyId: text('signin_key_id'),
		signinPublicKey: text('signin_public_key'),
		signinKeyChangedAt: timestamp('signin_key_changed_at', { withTimezone: true }),
		...stamps()
	},
	(t) => [oneOf('runner_kind_chk', t.kind, ['local', 'hosted', 'tool'])]
);

// -- OWNER APPROVALS FROM THE BOARD (AFB-20261108-1444) -- //

export const APPROVAL_ACTIONS = [
	'register',
	'secrets',
	'adopt-env',
	'roots',
	'pictures',
	'login'
] as const;
export const APPROVAL_STATUSES = [
	'pending',
	'approved',
	'refused',
	'expired',
	'cancelled',
	'claimed'
] as const;

/**
 * A request an agent filed through the bridge for the owner to decide on the board. The action and the target are normalised by the server, never taken from
 * the agent's words; `why` is the agent's own text and is shown only as a labelled quote. A request is decided once, claimed once, by the runner that asked.
 */
export const bridgeApproval = tenantTable(
	'bridge_approval',
	'org',
	{
		id: id(),
		orgId: orgId(),
		/** Display only; never used to decide who may decide. */
		projectId: uuid('project_id'),
		runnerId: uuid('runner_id')
			.notNull()
			.references(() => runner.id, { onDelete: 'cascade' }),
		/** The bridge's own id for a retry of the same request (unique per runner). */
		requestId: text('request_id').notNull(),
		/** Assigned by the server when a request has several entries; the entries of one batch are fixed when it is filed. */
		batchId: uuid('batch_id'),
		action: text('action', { enum: APPROVAL_ACTIONS }).notNull(),
		target: text('target').notNull(),
		contentHash: text('content_hash').notNull(),
		why: text('why'),
		status: text('status', { enum: APPROVAL_STATUSES }).notNull().default('pending'),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		requestedBy: text('requested_by').references(() => user.id, { onDelete: 'set null' }),
		decidedBy: text('decided_by').references(() => user.id, { onDelete: 'set null' }),
		decidedAt: timestamp('decided_at', { withTimezone: true }),
		decidedVia: text('decided_via', { enum: ['board', 'auto'] as const }),
		claimedAt: timestamp('claimed_at', { withTimezone: true }),
		claimedByRunner: uuid('claimed_by_runner'),
		...stamps()
	},
	(t) => [
		unique('bridge_approval_request_uq').on(t.runnerId, t.requestId),
		index('bridge_approval_status_idx').on(t.status, t.expiresAt),
		index('bridge_approval_batch_idx').on(t.batchId),
		// One waiting request for one action and target on one machine, so a second ask is the same card
		uniqueIndex('bridge_approval_pending_uq')
			.on(t.runnerId, t.action, t.target)
			.where(sql`${t.status} = 'pending'`),
		oneOf('bridge_approval_action_chk', t.action, APPROVAL_ACTIONS),
		oneOf('bridge_approval_status_chk', t.status, APPROVAL_STATUSES)
	]
);

/**
 * A test account's sign in, typed once on the board and encrypted in the browser to the public key of one tool machine. The server keeps ciphertext only: it never returns it
 * to a page, an agent or a history, and the bridge fetches it as a short lease and acknowledges the attempt, which wipes the ciphertext. Bound to org, runner, registration and key id.
 */
export const bridgeSigninEnvelope = tenantTable(
	'bridge_signin_envelope',
	'org',
	{
		id: id(),
		orgId: orgId(),
		runnerId: uuid('runner_id')
			.notNull()
			.references(() => runner.id, { onDelete: 'cascade' }),
		registration: text('registration').notNull(),
		keyId: text('key_id').notNull(),
		alg: text('alg').notNull(),
		ciphertext: text('ciphertext').notNull(),
		createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		leasedAt: timestamp('leased_at', { withTimezone: true }),
		consumedAt: timestamp('consumed_at', { withTimezone: true }),
		/** Only pass or fail, reported by the bridge after the attempt. */
		result: text('result', { enum: ['pass', 'fail'] as const }),
		...stamps()
	},
	(t) => [
		unique('bridge_signin_envelope_uq').on(t.runnerId, t.registration),
		index('bridge_signin_envelope_exp_idx').on(t.expiresAt)
	]
);

export const environment = tenantTable(
	'environment',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		name: text('name').notNull(),
		url: text('url').notNull(),
		kind: text('kind', { enum: TARGETS }).notNull(),
		production: boolean('production').notNull().default(false),
		/** Production is read only unless writes are allowed on purpose (L28). */
		writeAllowed: boolean('write_allowed').notNull().default(false),
		/** Where a deployed environment says which commit it runs, for the optional wait (L27). */
		versionPath: text('version_path'),
		...stamps(),
		version: version()
	},
	(t) => [
		unique('environment_name_uq').on(t.projectId, t.name),
		oneOf('environment_kind_chk', t.kind, TARGETS)
	]
);

/** One data key per org, wrapped by the master key from the environment (ADR-024). */
export const orgDataKey = tenantTable(
	'org_data_key',
	'org',
	{
		id: id(),
		orgId: orgId(),
		keyVersion: integer('key_version').notNull().default(1),
		wrappedKey: text('wrapped_key').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [unique('org_data_key_uq').on(t.orgId, t.keyVersion)]
);

export const secret = tenantTable(
	'secret',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		name: text('name').notNull(),
		ciphertext: text('ciphertext').notNull(),
		nonce: text('nonce').notNull(),
		keyVersion: integer('key_version').notNull().default(1),
		...stamps()
	},
	(t) => [unique('secret_name_uq').on(t.projectId, t.name)]
);

// -- BACKUPS (SPEC 8) -- //

export const backupRun = tenantTable(
	'backup_run',
	'org',
	{
		id: id(),
		orgId: orgId(),
		state: text('state').notNull(),
		size: integer('size'),
		location: text('location'),
		error: text('error'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [oneOf('backup_run_state_chk', t.state, ['running', 'done', 'failed'])]
);

// -- TOKENS AND CONNECTIONS (SPEC 6.2) -- //

export const apiToken = tenantTable(
	'api_token',
	'org',
	{
		id: id(),
		orgId: orgId(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		/** A prefix people and secret scanners can recognise. The token itself is stored only as a hash. */
		prefix: text('prefix').notNull(),
		hash: text('hash').notNull().unique(),
		/** pat (made in the web app), oauth (an MCP client, one hour, refreshed) or device (a CLI signed in by device code). */
		kind: text('kind').notNull().default('pat'),
		grantId: uuid('grant_id'),
		projectIds: uuid('project_ids')
			.array()
			.notNull()
			.default(sql`'{}'::uuid[]`),
		/** An upper limit only. Every call uses these intersected with the user's current role (L8). */
		permissions: jsonb('permissions')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		...stamps()
	},
	(t) => [
		index('api_token_user_idx').on(t.userId),
		oneOf('api_token_kind_chk', t.kind, ['pat', 'oauth', 'device'])
	]
);

/** MCP OAuth clients register themselves, so they are not tied to an org. Shown as unverified until reviewed (L7). */
export const oauthClient = pgTable('oauth_client', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	redirectUris: text('redirect_uris')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),
	verified: boolean('verified').notNull().default(false),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const oauthGrant = tenantTable(
	'oauth_grant',
	'org',
	{
		id: id(),
		orgId: orgId(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		clientId: text('client_id')
			.notNull()
			.references(() => oauthClient.id, { onDelete: 'cascade' }),
		scopes: text('scopes')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		/** The MCP address the tool was approved for (/mcp/<slug>), shown in Connected apps. Display only: the org binding is the token's own. Null for older grants. */
		resource: text('resource'),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		...stamps()
	},
	(t) => [index('oauth_grant_user_idx').on(t.userId)]
);

/** Device code sign in state lives in the database so it works across processes and restarts (L6). */
export const deviceCode = pgTable('device_code', {
	id: uuid('id').primaryKey().defaultRandom(),
	deviceCodeHash: text('device_code_hash').notNull().unique(),
	userCode: text('user_code').notNull().unique(),
	client: text('client').notNull(),
	origin: text('origin'),
	/**
	 * The hash (SHA-256, base64url) of a secret verifier the tool keeps and never sends. An agent approves a code only by presenting that verifier, so it can approve
	 * a code its own tool started and not one it was handed. Null for a sign in that sent none (a person approves those on the page).
	 */
	challengeHash: text('challenge_hash'),
	status: text('status').notNull().default('pending'),
	approvedBy: text('approved_by').references(() => user.id, { onDelete: 'set null' }),
	approvedOrgId: uuid('approved_org_id'),
	scopes: text('scopes')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),
	/** Polling faster than the interval answers slow_down (RFC 8628). */
	lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

/** A one time authorization code, `<orgId>.<secret>`, valid for 60 seconds and bound to a PKCE challenge (OAuth 2.1). */
export const oauthCode = tenantTable('oauth_code', 'org', {
	id: id(),
	orgId: orgId(),
	codeHash: text('code_hash').notNull().unique(),
	clientId: text('client_id').notNull(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	redirectUri: text('redirect_uri').notNull(),
	codeChallenge: text('code_challenge').notNull(),
	scopes: text('scopes')
		.array()
		.notNull()
		.default(sql`'{}'::text[]`),
	/** The MCP address the approval was for, copied to the grant when the code is exchanged. */
	resource: text('resource'),
	expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
	usedAt: timestamp('used_at', { withTimezone: true })
});

/** A refresh token, `afr_<orgId>.<secret>`. Each use replaces it, and reusing an old one revokes the whole grant. */
export const oauthRefresh = tenantTable(
	'oauth_refresh',
	'org',
	{
		id: id(),
		orgId: orgId(),
		grantId: uuid('grant_id').notNull(),
		tokenHash: text('token_hash').notNull().unique(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		replacedAt: timestamp('replaced_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [index('oauth_refresh_grant_idx').on(t.grantId)]
);
