// ZOD SCHEMAS GENERATED FROM THE DRIZZLE TABLES (drizzle-zod), SHARED BY THE API, THE MCP TOOL INPUTS AND THE FORMS
// Refinements add the rules a column type cannot hold: the tab name pattern.

// IMPORTED DEP-MODULES
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-zod';
import { z } from 'zod';
// IMPORTED MODULES
import { NOTE_LIMITS, NOTE_PICTURE_TYPES } from '../../shared/notes';
import { TAB_NAME } from '../../shared/tabName';
import {
	apiToken,
	attachment,
	authMethodSetting,
	comment,
	connectSetupMark,
	decision,
	item,
	member,
	mockup,
	mockupKit,
	mockupKitAsset,
	mockupPart,
	mockupPin,
	mockupProject,
	mockupRead,
	mockupTemplate,
	mockupVersion,
	note,
	noteFile,
	noteFolder,
	noteLink,
	noteVersion,
	org,
	phase,
	project,
	projectPin,
	screen,
	screenAnnotation,
	SETUP_KEYS,
	SETUP_STATES,
	section,
	session,
	step,
	task
} from './schema';

// -- CONSTANTS -- //

const tabName = z
	.string()
	.max(30, 'A tab name is at most 30 characters')
	.regex(TAB_NAME, 'Use 1 to 3 words in UPPERCASE joined by underscores, for example ROOM_TYPES');

// -- SELECT SCHEMAS (what a read returns) -- //

export const orgSelect = createSelectSchema(org);
export const memberSelect = createSelectSchema(member);
export const projectSelect = createSelectSchema(project);
export const itemSelect = createSelectSchema(item);
export const phaseSelect = createSelectSchema(phase);
export const stepSelect = createSelectSchema(step);
export const decisionSelect = createSelectSchema(decision);
export const sectionSelect = createSelectSchema(section);
export const taskSelect = createSelectSchema(task);
export const commentSelect = createSelectSchema(comment);
export const attachmentSelect = createSelectSchema(attachment);
export const sessionSelect = createSelectSchema(session);
export const mockupSelect = createSelectSchema(mockup);
export const mockupVersionSelect = createSelectSchema(mockupVersion);
export const mockupPinSelect = createSelectSchema(mockupPin);
/** The read record. The ranges are sorted [start, end) pairs that never overlap and never pass the HTML length. */
export const mockupReadRanges = z
	.array(z.tuple([z.number().int().min(0), z.number().int().min(0)]))
	.refine((r) => r.every(([a, b], i) => a < b && (i === 0 || r[i - 1][1] < a)), {
		message: 'The ranges must be sorted and must not overlap or touch.'
	});
export const mockupReadSelect = createSelectSchema(mockupRead, { ranges: mockupReadRanges });
export const mockupProjectSelect = createSelectSchema(mockupProject);
export const mockupTemplateSelect = createSelectSchema(mockupTemplate);
export const mockupKitSelect = createSelectSchema(mockupKit);
export const mockupKitAssetSelect = createSelectSchema(mockupKitAsset);
export const mockupPartSelect = createSelectSchema(mockupPart);
export const screenSelect = createSelectSchema(screen);
export const screenAnnotationSelect = createSelectSchema(screenAnnotation);

// -- SCREENS (AFB-20261124-0926): THE ONE INPUT SCHEMA OF THE UI, /api/v1, MCP AND THE BRIDGE -- //

/** A short slug that names a screen across captures. */
export const SCREEN_SLUG = /^[a-z0-9][a-z0-9._-]{0,59}$/;
export const screenAddInput = createInsertSchema(screen, {
	screenKey: (s) =>
		s.regex(SCREEN_SLUG, 'Use a short slug of lowercase letters, digits, dots, dashes'),
	width: (s) => s.int().min(200).max(4000),
	caption: (s) => s.max(200).optional(),
	note: (s) => s.max(1000).optional(),
	phaseKey: (s) => s.max(40).nullish()
})
	.pick({ screenKey: true, mode: true, width: true, caption: true, note: true, phaseKey: true })
	.extend({ item: z.string().min(1) });
export const screenAnnotationInput = createInsertSchema(screenAnnotation, {
	x: (s) => s.min(0).max(1),
	y: (s) => s.min(0).max(1),
	w: (s) => s.min(-1).max(1).nullish(),
	h: (s) => s.min(-1).max(1).nullish(),
	body: (s) => s.min(1).max(1000)
})
	.pick({ kind: true, x: true, y: true, w: true, h: true, body: true })
	.extend({ screen: z.string().uuid() })
	.superRefine((a, ctx) => {
		const end = (v: number, d: number | null | undefined) => v + (d ?? 0);
		if (a.kind === 'pin' && (a.w != null || a.h != null))
			ctx.addIssue({ code: 'custom', message: 'A pin has no size.' });
		if (a.kind !== 'pin' && (a.w == null || a.h == null))
			ctx.addIssue({ code: 'custom', message: 'A box or an arrow needs a width and a height.' });
		if (a.kind === 'box' && ((a.w ?? 0) <= 0 || (a.h ?? 0) <= 0))
			ctx.addIssue({ code: 'custom', message: 'A box has a positive width and height.' });
		if (a.kind !== 'pin') {
			const ex = end(a.x, a.w);
			const ey = end(a.y, a.h);
			if (ex < 0 || ex > 1 || ey < 0 || ey > 1)
				ctx.addIssue({ code: 'custom', message: 'The shape must stay inside the picture.' });
		}
	});
export const noteSelect = createSelectSchema(note);
export const noteFolderSelect = createSelectSchema(noteFolder);
export const noteVersionSelect = createSelectSchema(noteVersion);
export const noteLinkSelect = createSelectSchema(noteLink);
export const noteFileSelect = createSelectSchema(noteFile);

// -- INSERT AND UPDATE SCHEMAS (what a write accepts) -- //

/** What a person says about one tile of the Connect setup checklist: done, skipped or open and closed for the panel. A null state clears it. */
export const connectSetupMarkInput = createInsertSchema(connectSetupMark, {
	key: z.enum(SETUP_KEYS),
	state: z.enum(SETUP_STATES)
})
	.pick({ key: true, state: true })
	.extend({ state: z.enum(SETUP_STATES).nullable() })
	.refine(
		(v) => v.state === null || (v.key === 'panel') === (v.state === 'open' || v.state === 'closed'),
		{
			message: 'A tile is done or skipped, and only the panel is open or closed.'
		}
	);

/** A change to the sign in methods. Only what is sent changes. The secret is write only: it is sealed on the server and never read back. */
export const authMethodsInput = createUpdateSchema(authMethodSetting, {
	googleClientId: (s) => s.trim().min(10, 'That client ID looks too short').max(200),
	googleClientSecret: (s) => s.trim().min(8, 'That client secret looks too short').max(300)
})
	.pick({
		passwordEnabled: true,
		googleEnabled: true,
		googleClientId: true,
		googleClientSecret: true
	})
	// The secret cannot be cleared, only replaced
	.extend({ googleClientSecret: z.string().trim().min(8).max(300).optional() });

export const itemInsert = createInsertSchema(item, {
	tabName: tabName.nullable().optional(),
	title: (s) => s.min(3).max(200)
});
export const itemUpdate = createUpdateSchema(item, {
	tabName: tabName.nullable().optional(),
	title: (s) => s.min(3).max(200)
});
export const projectInsert = createInsertSchema(project, {
	key: (s) => s.regex(/^[A-Z][A-Z0-9]{1,9}$/, 'A project key is 2 to 10 capitals or digits')
});
export const orgInsert = createInsertSchema(org, {
	slug: (s) =>
		s.regex(/^[a-z0-9][a-z0-9-]{1,38}$/, 'A slug is lowercase letters, digits and dashes')
});
export const memberInsert = createInsertSchema(member);
export const phaseInsert = createInsertSchema(phase);
export const stepInsert = createInsertSchema(step);
export const decisionInsert = createInsertSchema(decision);
export const sectionInsert = createInsertSchema(section);
export const taskInsert = createInsertSchema(task);
export const commentInsert = createInsertSchema(comment);
export const attachmentInsert = createInsertSchema(attachment, {
	caption: (s) => s.min(1).max(200)
});
export const mockupInsert = createInsertSchema(mockup, {
	title: (s) => s.min(1).max(200)
});
export const mockupPinInsert = createInsertSchema(mockupPin, {
	body: (s) => s.min(1).max(2000),
	x: (s) => s.min(0).max(100),
	y: (s) => s.min(0).max(100)
});
export const mockupProjectUpdate = createUpdateSchema(mockupProject, {
	style: (s) => s.max(20_000)
});
export const mockupTemplateInsert = createInsertSchema(mockupTemplate, {
	name: (s) => s.min(1).max(80),
	prompt: (s) => s.max(20_000)
});
// -- NOTES (the limits live in shared/notes.ts) -- //

const noteTitle = z
	.string()
	.trim()
	.min(1, 'A note needs a title')
	.max(NOTE_LIMITS.title, `A title is at most ${NOTE_LIMITS.title} characters`);
const noteBody = z
	.string()
	.max(NOTE_LIMITS.body, `A note is at most ${NOTE_LIMITS.body.toLocaleString('en')} characters`);
// A slash is refused because tools name a folder by its path (Research/Competitors)
const folderName = z
	.string()
	.trim()
	.min(1, 'A folder needs a name')
	.max(NOTE_LIMITS.folderName, `A folder name is at most ${NOTE_LIMITS.folderName} characters`)
	.regex(/^[^/\\]+$/, 'A folder name cannot contain a slash');

export const noteInsert = createInsertSchema(note, { title: noteTitle, body: noteBody });
export const noteFolderInsert = createInsertSchema(noteFolder, { name: folderName });
export const noteLinkInsert = createInsertSchema(noteLink);
export const noteFileInsert = createInsertSchema(noteFile, {
	mime: z.enum(NOTE_PICTURE_TYPES, { error: 'A picture is a PNG, JPEG, WebP or GIF' }),
	size: (s) => s.min(1).max(NOTE_LIMITS.pictureBytes, 'A picture is at most 25 MB')
});
/** What a person or a tool sends to make a note. The org, the project, the number and the author come from the request. */
export const noteCreateInput = noteInsert
	.pick({ title: true, body: true, visibility: true, folderId: true })
	.partial({ body: true, visibility: true, folderId: true });
/** What a change to a note may carry. Every field is optional; the cause of the change is set by the server. */
export const noteUpdateInput = createUpdateSchema(note, { title: noteTitle, body: noteBody })
	.pick({
		title: true,
		body: true,
		visibility: true,
		folderId: true
	})
	// A schema given by hand replaces the generated optional one, so the fields are made optional again
	.partial();
export const noteFolderInput = noteFolderInsert.pick({ name: true, parentId: true });
export const noteLinkInput = noteLinkInsert.pick({ targetKind: true, targetId: true });
export const apiTokenInsert = createInsertSchema(apiToken);

/** Pin or unpin a project. Only the project comes from the caller; the org and the person always come from the request. */
export const projectPinInput = createInsertSchema(projectPin).pick({
	projectId: true
});

export { tabName as tabNameSchema };
