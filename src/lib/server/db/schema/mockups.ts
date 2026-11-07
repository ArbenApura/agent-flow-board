// MOCKUP TABLES: MOCKUPS, VERSIONS, PINNED COMMENTS, PROJECT STYLE, PAGE TEMPLATES AND THE PROJECT KIT

// -- DEP-MODULES -- //
import {
	bigint,
	boolean,
	index,
	integer,
	real,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
// -- MODULES -- //
import { orgId, projectId } from './core';
import { item } from './items';
import { VISIBILITIES, id, oneOf, stamps, tenantTable, version } from './helpers';

// -- CONSTANTS -- //

/** The widths a mockup may be shown at, in pixels. */
export const MOCKUP_SCREENS = { wide: 1600, laptop: 1280, tablet: 820, phone: 408 } as const;
export type MockupScreen = keyof typeof MOCKUP_SCREENS;
export const MOCKUP_SCREEN_KEYS = Object.keys(MOCKUP_SCREENS) as MockupScreen[];
/** Every mockup file lives under this prefix, so the general file route can refuse it. */
export const MOCKUP_KEY_PREFIX = 'mockups';

// -- MOCKUP -- //

export const mockup = tenantTable(
	'mockup',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		/** The plan it belongs to. The link is dropped (not the mockup) when the plan row is purged. */
		itemId: uuid('item_id').references(() => item.id, { onDelete: 'set null' }),
		title: text('title').notNull(),
		currentVersion: integer('current_version').notNull().default(1),
		/** Copied from the linked plan (or the project when standalone) by one helper, never read from the item at query time. */
		visibility: text('visibility', { enum: VISIBILITIES }).notNull().default('public'),
		publicEnabled: boolean('public_enabled').notNull().default(false),
		/** A sha256 of the random address, never the address itself. */
		publicTokenHash: text('public_token_hash'),
		trashedAt: timestamp('trashed_at', { withTimezone: true }),
		createdBy: text('created_by'),
		...stamps(),
		version: version()
	},
	(t) => [
		index('mockup_project_idx').on(t.projectId, t.trashedAt),
		index('mockup_item_idx').on(t.itemId),
		uniqueIndex('mockup_public_token_uq').on(t.publicTokenHash),
		oneOf('mockup_visibility_chk', t.visibility, VISIBILITIES)
	],
	// The public link finds its row by the hash of the address alone (the setting is set by the /m route and nothing else).
	// This policy only reads, and only a row whose link is on, whose own visibility is public and that is not in the trash.
	{
		selectPolicy: {
			name: 'public_link_read',
			using:
				"public_enabled and visibility = 'public' and trashed_at is null and public_token_hash is not null and public_token_hash = nullif(current_setting('app.mockup_token_hash', true), '')"
		}
	}
);

// -- VERSIONS (EACH OWNS ITS OWN STORED FILE) -- //

export const mockupVersion = tenantTable(
	'mockup_version',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		mockupId: uuid('mockup_id')
			.notNull()
			.references(() => mockup.id, { onDelete: 'cascade' }),
		number: integer('number').notNull(),
		storageKey: text('storage_key').notNull(),
		size: bigint('size', { mode: 'number' }).notNull(),
		checksum: text('checksum').notNull(),
		/** Layout, hierarchy, flow, states and copy worth keeping. Written by whoever published, so it is untrusted. */
		keepNotes: text('keep_notes').notNull().default(''),
		/** Pixels, colours and invented components that are free to change. */
		freeNotes: text('free_notes').notNull().default(''),
		screenshotKey: text('screenshot_key'),
		/** The version number this one was copied from, when it came from Restore. */
		restoredFrom: integer('restored_from'),
		createdBy: text('created_by'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		unique('mockup_version_number_uq').on(t.mockupId, t.number),
		uniqueIndex('mockup_version_key_uq').on(t.storageKey)
	]
);

// -- PINNED COMMENTS -- //

export const mockupPin = tenantTable(
	'mockup_pin',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		mockupId: uuid('mockup_id')
			.notNull()
			.references(() => mockup.id, { onDelete: 'cascade' }),
		versionNumber: integer('version_number').notNull(),
		/** Percent of the preview width and height, clamped to 0 to 100. */
		x: real('x').notNull(),
		y: real('y').notNull(),
		/** A short, bounded description of the element that was clicked. */
		hint: text('hint').notNull().default(''),
		body: text('body').notNull(),
		authorId: text('author_id'),
		author: text('author').notNull().default(''),
		/** Written by a guest or a viewer, so an agent reads it as untrusted. */
		untrusted: boolean('untrusted').notNull().default(false),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		/** The device the pin was placed on (one of MOCKUP_SCREEN_KEYS). Null for an older pin, which shows on every device. */
		device: text('device'),
		/** When a person marked the comment done. Null while it is open. */
		resolvedAt: timestamp('resolved_at', { withTimezone: true }),
		/** The display name of the person who resolved it, like `author`. A name, not a user reference. */
		resolvedBy: text('resolved_by')
	},
	(t) => [index('mockup_pin_mockup_idx').on(t.mockupId, t.versionNumber)]
);

// -- PROJECT STYLE, SCREENS AND THEMES -- //

export const mockupProject = tenantTable('mockup_project', 'project', {
	projectId: projectId().primaryKey(),
	orgId: orgId(),
	style: text('style').notNull().default(''),
	screens: text('screens')
		.array()
		.notNull()
		.$defaultFn(() => ['wide', 'laptop', 'tablet', 'phone']),
	themes: text('themes')
		.array()
		.notNull()
		.$defaultFn(() => []),
	updatedBy: text('updated_by'),
	updatedByLabel: text('updated_by_label'),
	...stamps(),
	version: version()
});

// -- PAGE TEMPLATES -- //

export const mockupTemplate = tenantTable(
	'mockup_template',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		name: text('name').notNull(),
		prompt: text('prompt').notNull().default(''),
		updatedBy: text('updated_by'),
		updatedByLabel: text('updated_by_label'),
		...stamps()
	},
	(t) => [unique('mockup_template_project_name_uq').on(t.projectId, t.name)]
);

// -- PROJECT KIT (A NEW ROW PER REBUILD) -- //

export const mockupKit = tenantTable(
	'mockup_kit',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		number: integer('number').notNull(),
		storageKey: text('storage_key').notNull(),
		size: bigint('size', { mode: 'number' }).notNull(),
		builtFromCommit: text('built_from_commit').notNull().default(''),
		builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
		summary: text('summary').notNull().default(''),
		/** Set by the agent when the design files changed after the kit was built, cleared by the next build. */
		stale: boolean('stale').notNull().default(false),
		createdBy: text('created_by'),
		createdByLabel: text('created_by_label')
	},
	(t) => [
		unique('mockup_kit_project_number_uq').on(t.projectId, t.number),
		uniqueIndex('mockup_kit_key_uq').on(t.storageKey)
	]
);
