// ZOD SCHEMAS GENERATED FROM THE DRIZZLE TABLES (drizzle-zod), SHARED BY THE API, THE MCP TOOL INPUTS AND THE FORMS
// Refinements add the rules a column type cannot hold: the tab name pattern.

// IMPORTED DEP-MODULES
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-zod';
import { z } from 'zod';
// IMPORTED MODULES
import { MOCKUP_FIDELITIES } from '../../board/mockups';
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
	PITFALL_PATH_MAX,
	PITFALL_TEXT_MAX,
	projectPitfall,
	QA_MODES,
	QA_OUTCOMES,
	QA_PRIORITIES,
	QA_SEVERITIES,
	qaFeature,
	qaResult,
	qaRun,
	screen,
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
/** The fidelity tier of a mockup version, as the tool and API replies carry it. */
export const mockupFidelitySchema = z.enum(MOCKUP_FIDELITIES);
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
// -- PROJECT PITFALLS (AFB-20261125-1527): THE ONE INPUT SCHEMA OF THE UI, /api/v1 AND MCP -- //

/** A new pitfall: its kind, one short plain fact, an optional repo path and the plan it came from. */
export const pitfallAddInput = createInsertSchema(projectPitfall, {
	text: (s) =>
		s
			.trim()
			.min(10, 'Write the fact in a few words (10 characters or more).')
			.max(PITFALL_TEXT_MAX, `Keep it to ${PITFALL_TEXT_MAX} characters.`),
	path: (s) => s.trim().max(PITFALL_PATH_MAX).nullish()
})
	.pick({ kind: true, text: true, path: true })
	.extend({ project: z.string().min(1).max(40), sourceItem: z.string().min(1).max(80).optional() });
export const pitfallRemoveInput = z.object({
	project: z.string().min(1).max(40),
	id: z.string().uuid()
});

// -- QA MAP (AFB-20261125-0442): THE ONE INPUT SCHEMA OF THE UI, /api/v1 AND MCP -- //

/** A stable slug for a feature, journey, step or case. */
export const QA_KEY = /^[a-z0-9][a-z0-9._-]{0,59}$/;
/** A place a run may target: scheme, host and port only, never sign in details or a path. */
export const QA_ORIGIN = /^https?:\/\/(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/;
/** The largest map one feature may hold, so one document never grows without bound. */
export const QA_MAP_MAX_CHARS = 200_000;
const qaKey = z
	.string()
	.regex(QA_KEY, 'Use a short slug of lowercase letters, digits, dots, dashes');
const qaText = (max: number) => z.string().max(max);
const qaCase = z.object({
	key: qaKey,
	input: qaText(400),
	technique: qaText(60).optional(),
	expected: qaText(1000),
	regression: z.boolean().optional()
});
const qaExpected = z.object({
	screen: qaText(1000).optional(),
	saved: qaText(1000).optional(),
	sent: qaText(1000).optional(),
	logged: qaText(1000).optional()
});
const qaStep = z.object({
	key: qaKey,
	page: qaText(300),
	action: qaText(300),
	control: qaText(200).optional(),
	expected: qaExpected,
	cases: z.array(qaCase).max(60).default([])
});
const qaJourney = z.object({
	key: qaKey,
	name: z.string().min(1).max(160),
	parent: qaKey.optional(),
	steps: z.array(qaStep).max(60)
});
export const qaMapSchema = z
	.object({ journeys: z.array(qaJourney).max(50) })
	.superRefine((m, ctx) => {
		if (JSON.stringify(m).length > QA_MAP_MAX_CHARS)
			ctx.addIssue({
				code: 'custom',
				message: 'This feature map is too large. Split the feature.'
			});
		const journeys = new Set<string>();
		for (const j of m.journeys) {
			if (journeys.has(j.key))
				ctx.addIssue({ code: 'custom', message: `Journey ${j.key} appears twice.` });
			journeys.add(j.key);
			const steps = new Set<string>();
			for (const s of j.steps) {
				if (steps.has(s.key))
					ctx.addIssue({ code: 'custom', message: `Step ${j.key}/${s.key} appears twice.` });
				steps.add(s.key);
				const cases = new Set<string>();
				for (const c of s.cases) {
					if (cases.has(c.key))
						ctx.addIssue({
							code: 'custom',
							message: `Case ${j.key}/${s.key}/${c.key} appears twice.`
						});
					cases.add(c.key);
				}
			}
		}
	});
const qaSizes = z
	.array(z.number().int().min(200).max(4000))
	.max(6)
	.refine((a) => new Set(a).size === a.length, 'Use each screen width once.');
export const qaFeatureInput = createInsertSchema(qaFeature, {
	key: () => qaKey,
	// An area is a path of up to four levels split by /, such as apps/centers/queue; a flat word still works
	area: (s) => s.max(80).optional(),
	name: (s) => s.min(1).max(120),
	description: (s) => s.max(2000).optional(),
	codeGlobs: () => z.array(z.string().min(1).max(200)).max(50).optional(),
	sizes: () => qaSizes.optional(),
	map: () => qaMapSchema
})
	.pick({
		key: true,
		area: true,
		name: true,
		description: true,
		codeGlobs: true,
		sizes: true,
		map: true
	})
	.extend({ expectVersion: z.number().int().positive().optional() });
export const qaMapMergeInput = z.object({
	project: z.string().min(1),
	features: z.array(qaFeatureInput).min(1).max(40),
	/** Feature keys the agent no longer finds in the app; they are flagged removed, never deleted. */
	missing: z.array(qaKey).max(200).optional()
});
export const qaFeatureEditInput = z.object({
	project: z.string().min(1),
	feature: qaKey,
	expectVersion: z.number().int().positive(),
	name: z.string().min(1).max(120).optional(),
	area: z.string().max(80).optional(),
	description: z.string().max(2000).optional(),
	priority: z.enum(QA_PRIORITIES).nullable().optional(),
	sizes: qaSizes.optional(),
	/** A whole new map from the page's editor; every path that differs from the stored map counts as edited. */
	map: qaMapSchema.optional()
});
export const qaFeatureMergeInput = z.object({
	project: z.string().min(1),
	from: qaKey,
	into: qaKey
});
export const qaFeatureSplitInput = z.object({
	project: z.string().min(1),
	feature: qaKey,
	journeys: z.array(qaKey).min(1).max(50),
	key: qaKey,
	name: z.string().min(1).max(120)
});
export const qaTargetsInput = z.object({
	project: z.string().min(1),
	targets: z
		.array(
			z.object({
				origin: z
					.string()
					.max(200)
					.transform((v) => v.trim().toLowerCase().replace(/\/$/, ''))
					.pipe(
						z.string().regex(QA_ORIGIN, 'Use an address like https://staging.example.com:8443')
					),
				writes: z.boolean()
			})
		)
		.max(20)
});
export const qaRunStartInput = createInsertSchema(qaRun, {
	scope: (s) => s.max(120).optional(),
	commit: (s) => s.max(80).optional(),
	sizes: () => qaSizes.optional()
})
	.pick({ scope: true, commit: true, sizes: true })
	.extend({
		project: z.string().min(1),
		/** The address of the app under test; only its origin is kept. */
		target: z.string().url().max(500),
		/** Feature keys to test; none means smoke and changed features first, then the rest. */
		features: z.array(qaKey).max(200).optional()
	});
export const qaResultRow = createInsertSchema(qaResult, {
	caseKey: (s) => s.min(1).max(200),
	width: (s) => s.int().min(200).max(4000),
	role: (s) => s.max(40).optional(),
	observed: (s) => s.max(2000).optional(),
	dataEntered: () =>
		z
			.array(z.object({ field: z.string().min(1).max(80), value: z.string().max(400) }))
			.max(40)
			.optional()
})
	.pick({
		caseKey: true,
		outcome: true,
		width: true,
		mode: true,
		role: true,
		observed: true,
		dataEntered: true
	})
	.extend({
		outcome: z.enum(QA_OUTCOMES),
		mode: z.enum(QA_MODES),
		severity: z.enum(QA_SEVERITIES).optional(),
		feature: qaKey,
		/** The page the case ran on, part of the bug's cause. */
		page: z.string().max(300).optional(),
		screen: z.string().uuid().optional()
	});
export const qaResultInput = z.object({
	run: z.string().min(1),
	results: z.array(qaResultRow).min(1).max(60)
});
export const qaPlanLinkInput = z.object({
	item: z.string().min(1),
	files: z.array(z.string().min(1).max(300)).max(200).optional()
});
export const qaRedactInput = z.object({ result: z.string().uuid() });
/** The owner's reason for closing a plan while a feature it touched is broken. */
export const qaOverrideInput = z.object({ reason: z.string().trim().min(3).max(160) });
export const qaFeatureSelect = createSelectSchema(qaFeature);
export const qaRunSelect = createSelectSchema(qaRun);
export const qaResultSelect = createSelectSchema(qaResult);
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
