// ZOD SCHEMAS GENERATED FROM THE DRIZZLE TABLES (drizzle-zod), SHARED BY THE API, THE MCP TOOL INPUTS AND THE FORMS
// Refinements add the rules a column type cannot hold: the tab name pattern.

// -- DEP-MODULES -- //
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-zod';
import { z } from 'zod';
// -- MODULES -- //
import { CONTINUE_MODES, CONTINUE_TOOL_IDS, validPair } from '../../shared/continue';
import { TAB_NAME } from '../../shared/tabName';
import {
	apiToken,
	attachment,
	check,
	comment,
	decision,
	environment,
	item,
	manualCheck,
	member,
	mockup,
	mockupKit,
	mockupPin,
	mockupProject,
	mockupRead,
	mockupTemplate,
	mockupVersion,
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
export const checkInsert = createInsertSchema(check);
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
