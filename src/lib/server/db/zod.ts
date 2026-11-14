// ZOD SCHEMAS GENERATED FROM THE DRIZZLE TABLES (drizzle-zod), SHARED BY THE API, THE MCP TOOL INPUTS AND THE FORMS
// Refinements add the rules a column type cannot hold: the tab name pattern.

// IMPORTED DEP-MODULES
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-zod';
import { z } from 'zod';
// IMPORTED MODULES
import { CONTINUE_MODES, CONTINUE_TOOL_IDS, validPair } from '../../shared/continue';
import { NOTE_LIMITS, NOTE_PICTURE_TYPES } from '../../shared/notes';
import { TAB_NAME } from '../../shared/tabName';
import {
	apiToken,
	attachment,
	check,
	comment,
	decision,
	devRegistration,
	environment,
	item,
	manualCheck,
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
	section,
	session,
	step,
	task,
	userPref
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
export const manualCheckSelect = createSelectSchema(manualCheck);
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
export const noteSelect = createSelectSchema(note);
export const noteFolderSelect = createSelectSchema(noteFolder);
export const noteVersionSelect = createSelectSchema(noteVersion);
export const noteLinkSelect = createSelectSchema(noteLink);
export const noteFileSelect = createSelectSchema(noteFile);

// -- INSERT AND UPDATE SCHEMAS (what a write accepts) -- //

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
export const manualCheckInsert = createInsertSchema(manualCheck);
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
export const checkInsert = createInsertSchema(check);
export const devRegistrationSelect = createSelectSchema(devRegistration);
export const devRegistrationInsert = createInsertSchema(devRegistration, {
	name: (s) => s.trim().min(1).max(60),
	devUrl: (s) => s.trim().min(1).max(300),
	profiles: () => z.array(z.string().trim().min(1).max(40)).max(20)
});
export const devRegistrationUpdate = createUpdateSchema(devRegistration);
export const devRegistrationInput = devRegistrationInsert
	.pick({
		name: true,
		devUrl: true,
		profiles: true,
		activeProfile: true,
		lastStatus: true,
		lastReasonCode: true
	})
	.partial({
		profiles: true,
		activeProfile: true,
		lastStatus: true,
		lastReasonCode: true
	});
export const environmentInsert = createInsertSchema(environment, { url: (s) => s.url() });
export const apiTokenInsert = createInsertSchema(apiToken);

/**
 * The "Continue with" choice of a person: a tool and a way. Open in VS Code is only valid with a tool that has the link.
 * Built from the user_pref table, so the enums are the same list the database check uses.
 */
export const continueChoice = createUpdateSchema(userPref, {
	continueTool: z.enum(CONTINUE_TOOL_IDS),
	continueMode: z.enum(CONTINUE_MODES)
})
	.pick({ continueTool: true, continueMode: true })
	.required()
	.refine((v) => validPair(v.continueTool, v.continueMode), {
		message: 'Open in VS Code works with Claude Code only. Pick Copy command or Copy prompt.',
		path: ['continueMode']
	});

/** Pin or unpin a project. Only the project comes from the caller; the org and the person always come from the request. */
export const projectPinInput = createInsertSchema(projectPin).pick({
	projectId: true
});

export { tabName as tabNameSchema };
