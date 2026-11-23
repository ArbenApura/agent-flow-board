// INTEGRATION TABLES: BACKUPS, TOKENS AND CONNECTIONS (SPEC 5, 6 AND 8)

// IMPORTED DEP-MODULES
import { sql } from 'drizzle-orm';
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid
} from 'drizzle-orm/pg-core';
// IMPORTED MODULES
import { orgId, user } from './core';
import { id, oneOf, stamps, tenantTable } from './helpers';

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
	/**
	 * The organisation slug the tool asked for (login --org). Only a validated slug is stored, never looked up when the code starts,
	 * so an unauthenticated caller cannot probe which orgs exist. It is checked when a person or an agent approves, and it is written once.
	 */
	requestedOrg: text('requested_org'),
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
