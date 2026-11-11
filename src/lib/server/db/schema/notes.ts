// NOTE TABLES: NOTES, FOLDERS, VERSIONS, LINKS, PICTURES, FAVOURITES AND LIVE EDITING UPDATES (AFB-20261111-0035)

// -- DEP-TYPES -- //
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
// -- DEP-MODULES -- //
import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	customType,
	index,
	integer,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
// -- MODULES -- //
import { orgId, projectId, user } from './core';
import { VISIBILITIES, id, oneOf, stamps, tenantTable, tsvector, version } from './helpers';

// -- CONSTANTS -- //

/** Why a version of a note was kept: people typing, a write by an agent, a write through the API with a token, or a restore. */
export const NOTE_CAUSES = ['typing', 'agent', 'api', 'restore'] as const;
export type NoteCause = (typeof NOTE_CAUSES)[number];
/** What a note can link to. */
export const NOTE_LINK_KINDS = ['item', 'task', 'mockup', 'note'] as const;
export type NoteLinkKind = (typeof NOTE_LINK_KINDS)[number];
/** Where a link came from: a Links panel (or the note_link tool), or a reference typed in the note's text. */
export const NOTE_LINK_SOURCES = ['panel', 'text'] as const;
export type NoteLinkSource = (typeof NOTE_LINK_SOURCES)[number];
/** Every picture of a note lives under this prefix, so the general file route can refuse it. */
export const NOTE_KEY_PREFIX = 'notes';
/** Stands in for "no parent" in the sibling name index, because PostgreSQL treats two NULLs as different values. */
export const NO_PARENT = '00000000-0000-0000-0000-000000000000';

// -- FUNCTIONS -- //

/** Raw bytes, for the Yjs updates of live editing. */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
	dataType: () => 'bytea',
	toDriver: (value) => Buffer.from(value),
	fromDriver: (value) => new Uint8Array(value)
});

// -- FOLDERS (A TREE OF ANY DEPTH) -- //

export const noteFolder = tenantTable(
	'note_folder',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		/** The folder this one sits in, or null at the top. The purge removes a folder with everything under it. */
		parentId: uuid('parent_id').references((): AnyPgColumn => noteFolder.id, {
			onDelete: 'cascade'
		}),
		name: text('name').notNull(),
		position: integer('position').notNull().default(0),
		/** A folder in the trash hides its sub-folders and notes by this state alone; they are not trashed one by one. */
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		deletedBy: text('deleted_by'),
		createdBy: text('created_by'),
		...stamps()
	},
	(t) => [
		index('note_folder_parent_idx').on(t.projectId, t.parentId),
		// One name among the live siblings of a parent, the top level included, compared without case
		uniqueIndex('note_folder_sibling_uq')
			.on(
				t.projectId,
				sql`coalesce(${t.parentId}, '${sql.raw(NO_PARENT)}'::uuid)`,
				sql`lower(${t.name})`
			)
			.where(sql`${t.deletedAt} is null`)
	]
);

// -- NOTE -- //

export const note = tenantTable(
	'note',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		/** Per project number, from the locked project_counter row. The reference is N-<number>. */
		number: integer('number').notNull(),
		title: text('title').notNull(),
		/** The text as Markdown. With live editing it is a checkpoint of the live document. */
		body: text('body').notNull().default(''),
		/** The purge deletes the notes under a folder itself, first; the cascade is only a backstop for the rows. */
		folderId: uuid('folder_id').references(() => noteFolder.id, { onDelete: 'cascade' }),
		/** public means shared with the project, private means the creator only (the same rule as a plan). */
		visibility: text('visibility', { enum: VISIBILITIES }).notNull().default('public'),
		createdBy: text('created_by'),
		updatedBy: text('updated_by'),
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		deletedBy: text('deleted_by'),
		/** Raised by every write from outside the live document, so an older window can never write the old text back. */
		epoch: integer('epoch').notNull().default(1),
		/** The number of the last live update of this epoch. Taken under a lock on this row, so number order is commit order. */
		updateSeq: integer('update_seq').notNull().default(0),
		/** The live update the stored body covers. */
		checkpointSeq: integer('checkpoint_seq').notNull().default(0),
		publicEnabled: boolean('public_enabled').notNull().default(false),
		/** A sha256 of the random address, never the address itself. */
		publicTokenHash: text('public_token_hash'),
		searchVector: tsvector('search_vector').generatedAlwaysAs(
			sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))`
		),
		...stamps(),
		version: version()
	},
	(t) => [
		index('note_search_idx').using('gin', t.searchVector),
		unique('note_project_number_uq').on(t.projectId, t.number),
		index('note_folder_idx').on(t.projectId, t.folderId, t.deletedAt),
		uniqueIndex('note_public_token_uq').on(t.publicTokenHash),
		oneOf('note_visibility_chk', t.visibility, VISIBILITIES)
	],
	// The public link finds its row by the hash of the address alone (the setting is set by the /n route and nothing else).
	// This policy only reads, and only a shared note whose link is on and that is not in the trash. A folder going to the
	// trash switches the links under it off, so this flat check is enough.
	{
		selectPolicy: {
			name: 'note_public_read',
			using:
				"public_enabled and visibility = 'public' and deleted_at is null and public_token_hash is not null and public_token_hash = nullif(current_setting('app.note_token_hash', true), '')"
		}
	}
);

// -- VERSIONS (ONLY EVER ADDED; THEY GO WITH THEIR NOTE WHEN IT IS PURGED) -- //

export const noteVersion = tenantTable(
	'note_version',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		noteId: uuid('note_id')
			.notNull()
			.references(() => note.id, { onDelete: 'cascade' }),
		number: integer('number').notNull(),
		title: text('title').notNull(),
		body: text('body').notNull(),
		cause: text('cause', { enum: NOTE_CAUSES }).notNull(),
		createdBy: text('created_by'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		unique('note_version_number_uq').on(t.noteId, t.number),
		oneOf('note_version_cause_chk', t.cause, NOTE_CAUSES)
	],
	{ appendOnly: true }
);

// -- LINKS TO PLANS, TASKS, MOCKUPS AND OTHER NOTES -- //

export const noteLink = tenantTable(
	'note_link',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		noteId: uuid('note_id')
			.notNull()
			.references(() => note.id, { onDelete: 'cascade' }),
		targetKind: text('target_kind', { enum: NOTE_LINK_KINDS }).notNull(),
		// No foreign key: the target is one of four tables. The purge removes links to purged targets, and reads join the target.
		targetId: uuid('target_id').notNull(),
		source: text('source', { enum: NOTE_LINK_SOURCES }).notNull(),
		createdBy: text('created_by'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		unique('note_link_uq').on(t.noteId, t.targetKind, t.targetId, t.source),
		index('note_link_target_idx').on(t.targetKind, t.targetId),
		oneOf('note_link_kind_chk', t.targetKind, NOTE_LINK_KINDS),
		oneOf('note_link_source_chk', t.source, NOTE_LINK_SOURCES)
	]
);

// -- PICTURES (EACH BELONGS TO ONE NOTE AND LIVES UNTIL THAT NOTE IS PURGED) -- //

export const noteFile = tenantTable(
	'note_file',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		noteId: uuid('note_id')
			.notNull()
			.references(() => note.id, { onDelete: 'cascade' }),
		storageKey: text('storage_key').notNull(),
		mime: text('mime').notNull(),
		size: bigint('size', { mode: 'number' }).notNull(),
		checksum: text('checksum').notNull(),
		createdBy: text('created_by'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('note_file_key_uq').on(t.storageKey),
		index('note_file_note_idx').on(t.noteId)
	],
	// A picture is read through a public link only when its own note is readable through that link
	{
		selectPolicy: {
			name: 'note_public_read',
			using:
				"exists (select 1 from note n where n.id = note_file.note_id and n.public_enabled and n.visibility = 'public' and n.deleted_at is null and n.public_token_hash is not null and n.public_token_hash = nullif(current_setting('app.note_token_hash', true), ''))"
		}
	}
);

// -- FAVOURITES (A STAR PER PERSON) -- //

export const noteFavourite = tenantTable(
	'note_favourite',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		noteId: uuid('note_id')
			.notNull()
			.references(() => note.id, { onDelete: 'cascade' }),
		userId: text('user_id')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [unique('note_favourite_uq').on(t.noteId, t.userId)]
);

// -- LIVE EDITING UPDATES (MERGED AND DELETED AS THE NOTE MOVES ON, SO NOT APPEND ONLY) -- //

export const noteUpdate = tenantTable(
	'note_update',
	'project',
	{
		id: id(),
		orgId: orgId(),
		projectId: projectId(),
		noteId: uuid('note_id')
			.notNull()
			.references(() => note.id, { onDelete: 'cascade' }),
		epoch: integer('epoch').notNull(),
		seq: integer('seq').notNull(),
		/** One Yjs update, checked by the server before it is stored. */
		update: bytea('update').notNull(),
		authorId: text('author_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [unique('note_update_seq_uq').on(t.noteId, t.epoch, t.seq)]
);
