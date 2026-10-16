// ZOD SCHEMAS GENERATED FROM THE DRIZZLE TABLES (drizzle-zod), SHARED BY THE API, THE MCP TOOL INPUTS AND THE FORMS
// Refinements add the rules a column type cannot hold: the tab name pattern and the "UI changes" row rules.

// -- DEP-MODULES -- //
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-zod';
import { z } from 'zod';
// -- MODULES -- //
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
	section,
	session,
	step,
	task,
	uiChange
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

export { tabName as tabNameSchema };
