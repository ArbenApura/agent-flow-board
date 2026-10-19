// ZOD SCHEMAS GENERATED FROM THE DRIZZLE TABLES (drizzle-zod), SHARED BY THE API, THE MCP TOOL INPUTS AND THE FORMS
// Refinements add the rules a column type cannot hold: the tab name pattern and the "UI changes" row rules.

// -- DEP-MODULES -- //
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-zod';
import { z } from 'zod';
// -- MODULES -- //
import { CONTINUE_MODES, CONTINUE_TOOL_IDS, validPair } from '../../shared/continue';
import {
	SKILL_BODY_MAX,
	SKILL_FILE_BODY_MAX,
	SKILL_FILES_MAX,
	SKILL_NAME,
	SKILL_NAME_HINT,
	SKILL_NAME_MAX,
	SKILL_SUMMARY_MAX,
	skillFilePathError,
	skillFilesError
} from '../../shared/skills';
import {
	STATE_STEP,
	TAB_NAME,
	UI_LEVELS,
	UI_THEMES,
	UI_VIEWPORTS,
	levelName
} from '../../shared/uiChange';
import {
	apiToken,
	attachment,
	check,
	comment,
	decision,
	environment,
	githubLink,
	item,
	manualCheck,
	member,
	org,
	phase,
	project,
	projectPin,
	section,
	session,
	skill,
	skillRevision,
	step,
	task,
	uiChange,
	userPref
} from './schema';

// -- CONSTANTS -- //

const tabName = z
	.string()
	.max(30, 'A tab name is at most 30 characters')
	.regex(TAB_NAME, 'Use 1 to 3 words in UPPERCASE joined by underscores, for example ROOM_TYPES');

/** A level from the vocabulary, optionally with its own selector, for example button-primary=css:.save-bar button. */
const level = z
	.string()
	.refine(
		(spec) =>
			(UI_LEVELS as readonly string[]).includes(levelName(spec)) &&
			(!spec.includes('=') || /^[^=]+=css:\S.*$/.test(spec)),
		'Unknown level. Use title, section, body, label, button-primary, button, button-icon, input, card, row, icon or image'
	);

/** The recipe of a state: steps joined by " > ", opening only. */
const stateRecipe = z
	.string()
	.refine(
		(value) => value === '' || value.split(' > ').every((step) => STATE_STEP.test(step.trim())),
		'A state step is click:, wait: or scroll: followed by a locator'
	);

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
export const skillSelect = createSelectSchema(skill);
export const skillRevisionSelect = createSelectSchema(skillRevision);

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
export const githubLinkInsert = createInsertSchema(githubLink);
export const apiTokenInsert = createInsertSchema(apiToken);
/** One supporting file of a skill. A jsonb column is untyped to drizzle-zod, so the shape and the path rule live here. */
export const skillFileInput = z
	.object({
		path: z.string().superRefine((path, ctx) => {
			const bad = skillFilePathError(path);
			if (bad) ctx.addIssue({ code: 'custom', message: bad });
		}),
		body: z.string().min(1).max(SKILL_FILE_BODY_MAX)
	})
	.strict();
/** The files of one skill: the count, each path and a path used twice. The total with the body is checked where the body is known. */
export const skillFilesInput = z
	.array(skillFileInput)
	.max(SKILL_FILES_MAX, `A skill holds at most ${SKILL_FILES_MAX} supporting files.`)
	.superRefine((files, ctx) => {
		const bad = skillFilesError('', files);
		if (bad) ctx.addIssue({ code: 'custom', message: bad });
	});
/** A custom skill: a lowercase slug that is not a built-in, a one line summary and a body under the cap. */
export const skillInsert = createInsertSchema(skill, {
	name: (s) => s.regex(SKILL_NAME, SKILL_NAME_HINT).max(SKILL_NAME_MAX),
	summary: (s) => s.min(1).max(SKILL_SUMMARY_MAX),
	body: (s) => s.min(1).max(SKILL_BODY_MAX),
	files: skillFilesInput.optional()
});
export const skillUpdate = createUpdateSchema(skill, {
	summary: (s) => s.min(1).max(SKILL_SUMMARY_MAX),
	body: (s) => s.min(1).max(SKILL_BODY_MAX),
	files: skillFilesInput.optional()
});

/** One "UI changes" row as a person or a tool writes it. Missing columns, unknown levels and bad viewports are refused. */
export const uiChangeInput = z.object({
	page: z.string().regex(/^\/\S*$/, 'A page is a route that starts with /'),
	stateRecipe,
	themes: z.array(z.enum(UI_THEMES)).min(1),
	accounts: z.string().min(1),
	siblings: z
		.array(z.string().min(1))
		.min(1, 'Name 1 to 3 sibling pages')
		.max(3, 'Name 1 to 3 sibling pages'),
	levels: z.array(level).min(1),
	viewports: z
		.array(
			z.union(UI_VIEWPORTS.map((v) => z.literal(v)) as [z.ZodLiteral<1440>, z.ZodLiteral<390>])
		)
		.min(1)
});
export const uiChangeInsert = createInsertSchema(uiChange);
export type UiChangeInput = z.infer<typeof uiChangeInput>;

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
