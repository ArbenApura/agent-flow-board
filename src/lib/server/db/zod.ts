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
	screen,
	SETUP_KEYS,
	SETUP_STATES,
	section,
	session,
	step,
	task,
	TEST_DEVICES,
	TEST_SURFACE_KINDS,
	testCase,
	testCaseVersion,
	testResult,
	testRun
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

// -- TESTING (AFB-20261127-0438): THE ONE INPUT SCHEMA OF THE UI, /api/v1 AND MCP -- //

/** A case key as the server gives it: TC-<CODE>-<NN>. */
export const TEST_CASE_KEY = /^TC-[A-Z0-9]{1,12}-\d{2,4}$/;
/** An area: up to four levels of lowercase words or UPPERCASE codes split by /. */
export const TEST_AREA =
	/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,39}){0,3}$/;
/** The largest proof picture, in bytes, and the most proofs one result may carry. */
export const TEST_PROOF_MAX_BYTES = 5 * 1024 * 1024;
export const TEST_PROOFS_PER_RESULT = 2;
const testCaseKey = z.string().regex(TEST_CASE_KEY, 'Use a case key like TC-AUTH-01');
const testDeviceSpec = z
	.object({
		device: z.enum(TEST_DEVICES),
		width: z.number().int().min(200).max(4000),
		height: z.number().int().min(200).max(4000)
	})
	.strict();
const testCaseBase = createInsertSchema(testCase, {
	area: (s) => s.regex(TEST_AREA, 'Use an area like AUTH or apps/centers/queue'),
	title: (s) => s.trim().min(3).max(200)
}).pick({ area: true, kind: true, title: true, priority: true });
const testVersionBase = createInsertSchema(testCaseVersion, {
	steps: () => z.array(z.object({ action: z.string().trim().min(1).max(400) }).strict()).max(30),
	inputData: (s) => s.max(2000).optional(),
	checks: () =>
		z
			.array(
				z
					.object({
						kind: z.enum(['text', 'url', 'element', 'count', 'clean', 'visual']),
						expect: z.string().trim().min(1).max(400)
					})
					.strict()
			)
			.min(1)
			.max(20),
	unitRef: (s) => s.max(300).nullish(),
	devices: () => z.array(testDeviceSpec).max(8),
	surfaces: () => z.array(z.string().min(3).max(200)).max(40).optional()
}).pick({
	steps: true,
	inputData: true,
	checks: true,
	unitRef: true,
	devices: true,
	mode: true,
	surfaces: true
});
/** Write a case: with no key a new case (TC key given by the server), with a key a new version of that case. */
export const testCaseSaveInput = testCaseBase
	.partial({ priority: true })
	.extend(testVersionBase.shape)
	.extend({
		project: z.string().min(1).max(40),
		key: testCaseKey.optional(),
		/** The short code in the key (AUTH, QUEUE); taken from the area when left out. */
		code: z
			.string()
			.regex(/^[A-Z0-9]{1,12}$/)
			.optional(),
		/** The plan writing it; the case is adopted as New (no key) or Update (a key). */
		plan: z.string().min(1).max(80).optional()
	})
	.superRefine((v, ctx) => {
		if (v.kind === 'ui' && v.devices.length === 0)
			ctx.addIssue({ code: 'custom', message: 'A UI case names at least one device.' });
		if (v.kind === 'unit' && !v.unitRef)
			ctx.addIssue({ code: 'custom', message: 'A unit case names the test it reads (unitRef).' });
	});
export const testCaseRetireInput = z.object({
	project: z.string().min(1).max(40),
	key: testCaseKey,
	plan: z.string().min(1).max(80).optional()
});
export const testPlanCasesInput = z.object({
	item: z.string().min(1).max(80),
	cases: z
		.array(z.object({ key: testCaseKey, role: z.enum(['reuse', 'update', 'retire']) }).strict())
		.max(200)
});
export const testRunStartInput = createInsertSchema(testRun, {
	objective: (s) => s.max(300).optional(),
	commit: (s) => s.max(80).optional(),
	harness: (s) => s.max(60).optional(),
	browser: (s) => s.max(60).optional(),
	reviewer: (s) => s.max(80).optional(),
	tier: (s) => s.max(20).optional()
})
	.pick({ objective: true, commit: true, harness: true, browser: true, reviewer: true, tier: true })
	.extend({ project: z.string().min(1).max(40), item: z.string().min(1).max(80).optional() });
const testProofInput = z
	.object({
		/** The step it shows; left out for the end state. */
		step: z.number().int().min(1).max(30).optional(),
		/** The picture as base64 (PNG, JPEG, WebP or AVIF, read from the bytes). */
		data: z
			.string()
			.min(16)
			.max(Math.ceil((TEST_PROOF_MAX_BYTES * 4) / 3) + 8)
	})
	.strict();
const testResultBase = createInsertSchema(testResult, {
	reason: (s) => s.max(120).optional(),
	failedStep: (s) => s.int().min(1).max(30).nullish(),
	actual: (s) => s.max(2000).optional(),
	output: (s) => s.max(4000).optional(),
	consoleLines: () => z.array(z.string().max(2000)).max(20).optional(),
	browser: (s) => s.max(60).optional(),
	// Light unless the case is a dark-mode case, so a plain result needs no mode
	mode: (s) => s.default('light')
}).pick({
	device: true,
	mode: true,
	status: true,
	reason: true,
	failedStep: true,
	actual: true,
	output: true,
	consoleLines: true,
	browser: true,
	severity: true,
	bugPriority: true
});
export const testResultRow = testResultBase
	.extend({
		case: testCaseKey,
		/** The size it ran at; taken from the case's device when left out. */
		width: z.number().int().min(200).max(4000).optional(),
		height: z.number().int().min(200).max(4000).optional(),
		proofs: z.array(testProofInput).max(TEST_PROOFS_PER_RESULT).optional()
	})
	.strict();
/** All the pictures of one call together, as base64: about 15 MB decoded, so a call cannot fill memory or disk at once. */
export const TEST_PROOF_CALL_MAX_CHARS = 20_000_000;
// The cap is checked by recordResults, not refined here: the API route omits `run` from this schema, and a refined object cannot be omitted
export const testResultInput = z.object({
	run: z.string().uuid(),
	results: z.array(testResultRow).min(1).max(10)
});
export const testRunFinishInput = z.object({ run: z.string().uuid() });
export const testSurfacesInput = z.object({
	project: z.string().min(1).max(40),
	surfaces: z
		.array(
			z
				.object({ kind: z.enum(TEST_SURFACE_KINDS), key: z.string().trim().min(1).max(200) })
				.strict()
		)
		.max(3000)
});
export const testCaseSelect = createSelectSchema(testCase);
export const testRunSelect = createSelectSchema(testRun);
export const testResultSelect = createSelectSchema(testResult);
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
