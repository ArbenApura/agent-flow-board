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
