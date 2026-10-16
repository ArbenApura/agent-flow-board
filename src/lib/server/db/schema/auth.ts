// AUTH TABLES: BETTER AUTH'S SESSION, ACCOUNT AND VERIFICATION, PLUS LOCKOUT, KNOWN DEVICES AND ORG INVITES (SPEC 6.1)
// Better Auth's own models are named auth_* so they never clash with the agent `session` table of SPEC 5.

// -- DEP-MODULES -- //
import {
	bigint,
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	unique
} from 'drizzle-orm/pg-core';
// -- MODULES -- //
import { orgId, user } from './core';
import { ROLES, id, oneOf, stamps, tenantTable } from './helpers';

// -- BETTER AUTH MODELS (not tenant scoped: a sign in happens before any org is chosen) -- //

export const authSession = pgTable(
	'auth_session',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		token: text('token').notNull().unique(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		...stamps()
	},
	(t) => [index('auth_session_user_idx').on(t.userId)]
);

export const authAccount = pgTable(
	'auth_account',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		accountId: text('account_id').notNull(),
		providerId: text('provider_id').notNull(),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
		refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
		scope: text('scope'),
		/** The password hash for the email and password provider. Never returned by any API. */
		password: text('password'),
		...stamps()
	},
	(t) => [
		index('auth_account_user_idx').on(t.userId),
		unique('auth_account_provider_uq').on(t.providerId, t.accountId)
	]
);

export const authVerification = pgTable(
	'auth_verification',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		...stamps()
	},
	(t) => [index('auth_verification_identifier_idx').on(t.identifier)]
);

/** Better Auth's request limits, kept in the database so every server and Worker isolate counts the same. */
export const authRateLimit = pgTable('auth_rate_limit', {
	id: text('id').primaryKey(),
	key: text('key').notNull().unique(),
	count: integer('count').notNull(),
	lastRequest: bigint('last_request', { mode: 'number' }).notNull()
});

// -- LOCKOUT AND DEVICES -- //

/** Failed sign in count per email, so repeated guesses lock the account for a while (L8 family, SPEC 6.1). */
export const authLockout = pgTable('auth_lockout', {
	email: text('email').primaryKey(),
	failures: integer('failures').notNull().default(0),
	lockedUntil: timestamp('locked_until', { withTimezone: true }),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

/** A device a person signed in from before. A new one triggers an alert email. */
export const authDevice = pgTable(
	'auth_device',
	{
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		/** A hash of the user agent and the network prefix, never the raw address. */
		fingerprint: text('fingerprint').notNull(),
		label: text('label').notNull(),
		firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [unique('auth_device_uq').on(t.userId, t.fingerprint)]
);

// -- INVITES (TENANT SCOPED, BOUND TO ONE EMAIL ADDRESS) -- //

export const invite = tenantTable(
	'invite',
	'org',
	{
		id: id(),
		orgId: orgId(),
		email: text('email').notNull(),
		role: text('role', { enum: ROLES }).notNull().default('member'),
		/** Only the hash is stored. The token itself is `<orgId>.<secret>` and is mailed once. */
		tokenHash: text('token_hash').notNull().unique(),
		invitedBy: text('invited_by').references(() => user.id, { onDelete: 'set null' }),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		acceptedAt: timestamp('accepted_at', { withTimezone: true }),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		emailFailed: boolean('email_failed').notNull().default(false),
		...stamps()
	},
	(t) => [
		index('invite_org_email_idx').on(t.orgId, t.email),
		oneOf('invite_role_chk', t.role, ROLES)
	]
);
