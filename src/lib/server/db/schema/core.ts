// IDENTITY AND STRUCTURE TABLES: USER, ORG, MEMBER, PROJECT (SPEC 5)

// IMPORTED DEP-TYPES
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
// IMPORTED DEP-MODULES
import { getTableColumns, sql } from 'drizzle-orm';
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uuid
} from 'drizzle-orm/pg-core';
// IMPORTED MODULES
import { CONTINUE_MODES, CONTINUE_TOOL_IDS } from '../../../shared/continue';
import { ROLES, id, oneOf, stamps, tenantTable, version } from './helpers';

// -- TYPES -- //

export type OrgPalette = {
	seed: string;
	light: Record<string, string>;
	dark: Record<string, string>;
};
/** Limits an org sets for itself (SPEC 11, Organisation settings). Missing means the default. */
export type OrgSettings = {
	/** The longest an access token may live, 1 to 90 days. */
	tokenMaxDays?: number;
	/** Whether people may be invited as guests. */
	allowGuestInvites?: boolean;
	/** Who has turned on "let my agent handle approvals on its own" (a user id and when). Never shown to other members, never changed by a token. */
	autoApproveBy?: Record<string, { at: string }>;
};
export type StreamConfig = { stream: string; scopes: string[] }[];
export type ProjectThemes = { key: string; label: string }[];

// -- USER (not tenant scoped: a person can belong to several orgs; shaped for Better Auth) -- //

export const user = pgTable('user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: boolean('email_verified').notNull().default(false),
	image: text('image'),
	...stamps()
});

// -- ORG -- //

export const org = tenantTable(
	'org',
	'org',
	{
		id: id(),
		name: text('name').notNull(),
		slug: text('slug').notNull().unique(),
		palette: jsonb('palette').$type<OrgPalette>(),
		logo: text('logo'),
		settings: jsonb('settings')
			.$type<OrgSettings>()
			.notNull()
			.default(sql`'{}'::jsonb`),
		/** Set when an owner deletes the org. The org is locked until it is restored or erased once the grace period ends. */
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		/** Set when the purge claims the org. From then on it can no longer be restored. */
		purgeStartedAt: timestamp('purge_started_at', { withTimezone: true }),
		...stamps(),
		version: version()
	},
	undefined,
	// An org row is visible while the request is inside that org, when it names the org by slug (how a URL finds
	// its org), and to a person who is a member of it (how the org list is found before an org is chosen)
	{
		orgColumn: 'id',
		using:
			"id = nullif(current_setting('app.org_id', true), '')::uuid or slug = nullif(current_setting('app.org_slug', true), '') or id in (select org_id from member where user_id = nullif(current_setting('app.user_id', true), '')) or (current_setting('app.purge_sweep', true) = 'on' and deleted_at is not null)"
	}
);

/** The org reference every tenant table carries. */
export const orgId = () =>
	uuid('org_id')
		.notNull()
		.references((): AnyPgColumn => org.id, { onDelete: 'cascade' });

// -- MEMBER -- //

export const member = tenantTable(
	'member',
	'org',
	{
		id: id(),
		orgId: orgId(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		role: text('role', { enum: ROLES }).notNull().default('member'),
		...stamps(),
		version: version()
	},
	(t) => [
		unique('member_org_user_uq').on(t.orgId, t.userId),
		index('member_user_idx').on(t.userId),
		oneOf('member_role_chk', t.role, ROLES)
	],
	// A person can always list their own memberships, which is how the org list is found before an org is chosen
	{
		using:
			"org_id = nullif(current_setting('app.org_id', true), '')::uuid or user_id = nullif(current_setting('app.user_id', true), '')"
	}
);

// -- PROJECT -- //

export const project = tenantTable(
	'project',
	'org',
	{
		id: id(),
		orgId: orgId(),
		key: text('key').notNull(),
		name: text('name').notNull(),
		/** A small picture as a data address. Served by /pictures/project/{id}, so reads select projectCols and never carry it. */
		logo: text('logo'),
		streams: jsonb('streams')
			.$type<StreamConfig>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		rules: text('rules').notNull().default(''),
		webApp: boolean('web_app').notNull().default(false),
		themes: jsonb('themes')
			.$type<ProjectThemes>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** ADR-027: on by default, off for the imported HAPR project. */
		agentsMayComplete: boolean('agents_may_complete').notNull().default(true),
		staleDays: integer('stale_days').notNull().default(3),
		/** Pages UI shots compare new screens with, as addresses inside the web app. */
		referencePages: text('reference_pages')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		/** File globs that infer a step is visually verifiable when the item has a linked mockup. */
		screenGlobs: text('screen_globs')
			.array()
			.notNull()
			.default(
				sql`ARRAY['**/*.svelte','**/*.tsx','**/*.vue','**/*.css','**/routes/**','**/components/**']::text[]`
			),
		/** Per-project switch turning the Phase C visible-step compare evidence gate on or off. */
		visualEvidenceGate: boolean('visual_evidence_gate').notNull().default(false),
		...stamps(),
		version: version()
	},
	(t) => [
		unique('project_org_key_uq').on(t.orgId, t.key),
		// Projects are found by upper(key)
		index('project_org_upper_key_idx').on(t.orgId, sql`upper(${t.key})`)
	]
);

/** Every project column except the picture, for reads that answer to a page, the API or a tool. */
const { logo: _logo, ...projectColumns } = getTableColumns(project);
export const projectCols = projectColumns;

/** The version of a project's logo as a number, or null when it has none. Pages use it to ask /pictures for the bytes. */
export const projectLogoV = sql<
	number | null
>`case when ${project.logo} is not null then floor(extract(epoch from ${project.updatedAt}) * 1000)::float8 end`;

/** The version of a person's avatar as a number, or null when they have none. Only a small PNG, JPEG or WebP data address counts as a picture, whatever wrote the column. */
export const userPictureV = sql<
	number | null
>`case when ${user.image} ~ '^data:image/(png|jpeg|webp);base64,' and length(${user.image}) <= 300000 then floor(extract(epoch from ${user.updatedAt}) * 1000)::float8 end`;

/** The project reference every project scoped table carries. */
export const projectId = () =>
	uuid('project_id')
		.notNull()
		.references((): AnyPgColumn => project.id, { onDelete: 'cascade' });

export const projectMember = tenantTable(
	'project_member',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		role: text('role', { enum: ROLES }).notNull(),
		...stamps(),
		version: version()
	},
	(t) => [
		unique('project_member_uq').on(t.projectId, t.userId),
		oneOf('project_member_role_chk', t.role, ROLES)
	]
);

/** A project a person pinned on the org home. Personal: the row filter names the org and the person (FLOW AFB-20261017-0537). */
export const projectPin = tenantTable(
	'project_pin',
	'org',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		unique('project_pin_uq').on(t.userId, t.projectId),
		index('project_pin_org_idx').on(t.orgId)
	],
	// The org wall and the person wall. WITH CHECK is the org wall only, so the verb always writes the caller's own id
	{
		using:
			"org_id = nullif(current_setting('app.org_id', true), '')::uuid and user_id = nullif(current_setting('app.user_id', true), '')"
	}
);

/** Next item number per project. The row is locked inside the insert transaction (SPEC 5). */
export const projectCounter = tenantTable('project_counter', 'project', {
	projectId: uuid('project_id')
		.primaryKey()
		.references((): AnyPgColumn => project.id, { onDelete: 'cascade' }),
	orgId: orgId(),
	next: integer('next').notNull().default(1),
	/** The same counter for tasks, so T-04 style numbers never repeat. */
	nextTask: integer('next_task').notNull().default(1),
	/** The same counter for notes (N-12). */
	nextNote: integer('next_note').notNull().default(1)
});

// -- ORG DELETION LOG (outlives the org: org_id has no foreign key, so the purge does not erase it) -- //

export const ORG_DELETION_EVENTS = ['deleted', 'restored', 'purged'] as const;

/** Who deleted which org and when. Insert only. It holds no tokens, secrets or org content. */
export const orgDeletionLog = tenantTable(
	'org_deletion_log',
	'org',
	{
		id: id(),
		/** The org this row is about. Not a foreign key on purpose, the row must survive the org. */
		orgId: uuid('org_id').notNull(),
		orgName: text('org_name').notNull(),
		/** Not unique: the address is free again once the org is erased. */
		orgSlug: text('org_slug').notNull(),
		event: text('event', { enum: ORG_DELETION_EVENTS }).notNull(),
		/** The person who acted. Not a foreign key, so deleting a person never changes the log. */
		actorUserId: text('actor_user_id'),
		actorLabel: text('actor_label').notNull().default(''),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('org_deletion_log_org_idx').on(t.orgId),
		oneOf('org_deletion_log_event_chk', t.event, ORG_DELETION_EVENTS)
	],
	{ appendOnly: true }
);

// -- USER PREFERENCES (one row per person, readable by that person only) -- //

export const userPref = pgTable(
	'user_pref',
	{
		userId: text('user_id')
			.primaryKey()
			.references(() => user.id, { onDelete: 'cascade' }),
		themeMode: text('theme_mode').notNull().default('system'),
		accent: text('accent'),
		checkTarget: text('check_target'),
		notifications: jsonb('notifications')
			.notNull()
			.default(sql`'{}'::jsonb`),
		/** The tool the "Continue with" action starts with, and how it carries on (FLOW-20261017-0916). */
		continueTool: text('continue_tool').notNull().default('claude-code'),
		continueMode: text('continue_mode').notNull().default('vscode'),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		oneOf('user_pref_continue_tool_chk', t.continueTool, CONTINUE_TOOL_IDS),
		oneOf('user_pref_continue_mode_chk', t.continueMode, CONTINUE_MODES)
	]
);
