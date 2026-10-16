// IDENTITY AND STRUCTURE TABLES: USER, ORG, MEMBER, PROJECT (SPEC 5)

// -- DEP-TYPES -- //
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
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
	uuid
} from 'drizzle-orm/pg-core';
// -- MODULES -- //
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
		...stamps(),
		version: version()
	},
	undefined,
	// An org row is visible while the request is inside that org, when it names the org by slug (how a URL finds
	// its org), and to a person who is a member of it (how the org list is found before an org is chosen)
	{
		orgColumn: 'id',
		using:
			"id = nullif(current_setting('app.org_id', true), '')::uuid or slug = nullif(current_setting('app.org_slug', true), '') or id in (select org_id from member where user_id = nullif(current_setting('app.user_id', true), ''))"
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
		colourTag: text('colour_tag'),
		streams: jsonb('streams')
			.$type<StreamConfig>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		rules: text('rules').notNull().default(''),
		webApp: boolean('web_app').notNull().default(false),
		/** The target browser checks use when nobody picks one: the build preview, never the dev server (ADR-017). */
		defaultTarget: text('default_target').notNull().default('preview'),
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
		...stamps(),
		version: version()
	},
	(t) => [unique('project_org_key_uq').on(t.orgId, t.key)]
);

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

/** Next item number per project. The row is locked inside the insert transaction (SPEC 5). */
export const projectCounter = tenantTable('project_counter', 'project', {
	projectId: uuid('project_id')
		.primaryKey()
		.references((): AnyPgColumn => project.id, { onDelete: 'cascade' }),
	orgId: orgId(),
	next: integer('next').notNull().default(1),
	/** The same counter for tasks, so T-04 style numbers never repeat. */
	nextTask: integer('next_task').notNull().default(1)
});

// -- USER PREFERENCES (one row per person, readable by that person only) -- //

export const userPref = pgTable('user_pref', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	themeMode: text('theme_mode').notNull().default('system'),
	accent: text('accent'),
	checkTarget: text('check_target'),
	notifications: jsonb('notifications')
		.notNull()
		.default(sql`'{}'::jsonb`),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});
