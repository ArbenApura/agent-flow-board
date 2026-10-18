// THE BRIDGE'S SKILL FILES (AFB-20261018-0622): THE THREE TARGETS, THE MANIFEST AND HAND EDIT DRIFT

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	EMPTY_MANIFEST,
	MANIFEST_PATH,
	TARGETS,
	contentHash,
	manifestText,
	parseManifest,
	planSkills,
	skillFileText,
	type RemoteSkill
} from './materialize';

// -- CONSTANTS -- //

const NOTES: RemoteSkill = {
	name: 'release-notes',
	summary: 'How we write the release notes',
	body: 'Read the commits since the last tag.',
	hash: ''
};
NOTES.hash = contentHash(`${NOTES.name}\n\n${NOTES.summary}\n\n${NOTES.body}`);

const SECOND: RemoteSkill = {
	name: 'triage',
	summary: 'How a bug is triaged',
	body: 'Read the report, then label it.',
	hash: ''
};
SECOND.hash = contentHash(`${SECOND.name}\n\n${SECOND.summary}\n\n${SECOND.body}`);

/** A tiny file system, so the plan is read and written the same way the checkout is. */
function disk(initial: Record<string, string> = {}) {
	const files = new Map(Object.entries(initial));
	return {
		read: (path: string) => files.get(path) ?? null,
		write: (path: string, text: string) => files.set(path, text),
		remove: (path: string) => files.delete(path),
		has: (path: string) => files.has(path),
		get: (path: string) => files.get(path) ?? null
	};
}

/** Runs a plan on the fake disk, as the command does. */
function apply(d: ReturnType<typeof disk>, plan: ReturnType<typeof planSkills>) {
	for (const f of plan.files) {
		if (f.action === 'unchanged' || f.action === 'drift') continue;
		if (f.action === 'remove') d.remove(f.path);
		else d.write(f.path, f.text ?? '');
	}
	d.write(MANIFEST_PATH, manifestText(plan.manifest));
}

// -- TESTS -- //

describe('skill files', () => {
	it('make a SKILL.md with flat front matter and the body as written', () => {
		const text = skillFileText({ name: 'x', summary: 'a  long\nsummary', body: 'Body.\n' });
		expect(text).toBe('---\nname: x\ndescription: a long summary\n---\n\nBody.\n');
	});

	it('write the same skill for Claude, Antigravity and Gemini', () => {
		const d = disk();
		const plan = planSkills([NOTES], EMPTY_MANIFEST, d.read);
		apply(d, plan);
		for (const target of Object.keys(TARGETS) as (keyof typeof TARGETS)[]) {
			const path = TARGETS[target]('release-notes');
			expect(d.get(path), target).toContain('Read the commits since the last tag.');
		}
		expect(plan.files.filter((f) => f.action === 'create')).toHaveLength(3);
		// The manifest records the board's hash and the bytes written for each target, so a later run can tell its own files apart
		expect(parseManifest(d.get(MANIFEST_PATH)).skills['release-notes'].hash).toBe(NOTES.hash);
		expect(Object.keys(parseManifest(d.get(MANIFEST_PATH)).skills['release-notes'].files)).toEqual(
			Object.values(TARGETS).map((path) => path('release-notes'))
		);
	});

	it('leave an up to date file alone, and update one whose skill changed', () => {
		const d = disk();
		apply(d, planSkills([NOTES], EMPTY_MANIFEST, d.read));
		expect(
			planSkills([NOTES], parseManifest(d.get(MANIFEST_PATH)), d.read).files.every(
				(f) => f.action === 'unchanged'
			)
		).toBe(true);

		const changed = { ...NOTES, body: 'Read the commits, then write two paragraphs.', hash: 'new' };
		const plan = planSkills([changed], parseManifest(d.get(MANIFEST_PATH)), d.read);
		expect(plan.files.filter((f) => f.action === 'update')).toHaveLength(3);
		apply(d, plan);
		expect(d.get(TARGETS.claude('release-notes'))).toContain('two paragraphs');
	});

	it('report a hand edit as drift, keep it, and overwrite it only with force', () => {
		const d = disk();
		apply(d, planSkills([NOTES], EMPTY_MANIFEST, d.read));
		const path = TARGETS.claude('release-notes');
		d.write(path, 'A person edited this file.');
		const plan = planSkills([NOTES], parseManifest(d.get(MANIFEST_PATH)), d.read);
		expect(plan.files.find((f) => f.path === path)?.action).toBe('drift');
		apply(d, plan);
		expect(d.get(path)).toBe('A person edited this file.');
		// The record stays, so the next run still sees the edit
		expect(
			planSkills([NOTES], parseManifest(d.get(MANIFEST_PATH)), d.read).files.find(
				(f) => f.path === path
			)?.action
		).toBe('drift');

		const forced = planSkills([NOTES], parseManifest(d.get(MANIFEST_PATH)), d.read, {
			force: true
		});
		expect(forced.files.find((f) => f.path === path)?.action).toBe('update');
		apply(d, forced);
		expect(d.get(path)).toContain('Read the commits');
	});

	it('keeps a hand edit as drift without turning the files it did write into drift too', () => {
		const d = disk();
		apply(d, planSkills([NOTES], EMPTY_MANIFEST, d.read));
		const edited = TARGETS.claude('release-notes');
		d.write(edited, 'A person edited this file.');
		const v2 = { ...NOTES, body: 'Second version.', hash: 'v2' };
		const plan = planSkills([v2], parseManifest(d.get(MANIFEST_PATH)), d.read);
		expect(plan.files.find((f) => f.path === edited)?.action).toBe('drift');
		expect(plan.files.filter((f) => f.action === 'update')).toHaveLength(2);
		apply(d, plan);
		// The next change still reports only the hand edited file, and updates the two the bridge wrote
		const v3 = { ...NOTES, body: 'Third version.', hash: 'v3' };
		const next = planSkills([v3], parseManifest(d.get(MANIFEST_PATH)), d.read);
		expect(next.files.filter((f) => f.action === 'drift').map((f) => f.path)).toEqual([edited]);
		expect(next.files.filter((f) => f.action === 'update')).toHaveLength(2);
	});

	it('never takes over a file it did not write', () => {
		const d = disk({ [TARGETS.gemini('release-notes')]: 'Gemini only text.' });
		const plan = planSkills([NOTES], EMPTY_MANIFEST, d.read);
		expect(plan.files.find((f) => f.path === TARGETS.gemini('release-notes'))?.action).toBe(
			'drift'
		);
		apply(d, plan);
		expect(d.get(TARGETS.gemini('release-notes'))).toBe('Gemini only text.');
	});

	it('remove the files of a skill the board no longer has, and keep a hand edited one', () => {
		const d = disk();
		apply(d, planSkills([NOTES, SECOND], EMPTY_MANIFEST, d.read));
		d.write(TARGETS.claude('triage'), 'Edited by hand.');
		const plan = planSkills([NOTES], parseManifest(d.get(MANIFEST_PATH)), d.read);
		expect(plan.files.filter((f) => f.action === 'remove').map((f) => f.path)).toEqual([
			TARGETS.antigravity('triage'),
			TARGETS.gemini('triage')
		]);
		expect(plan.files.find((f) => f.path === TARGETS.claude('triage'))?.action).toBe('drift');
		apply(d, plan);
		expect(d.has(TARGETS.antigravity('triage'))).toBe(false);
		expect(d.has(TARGETS.gemini('triage'))).toBe(false);
		expect(d.get(TARGETS.claude('triage'))).toBe('Edited by hand.');
	});

	it('reads a broken or missing manifest as empty', () => {
		expect(parseManifest(null)).toEqual(EMPTY_MANIFEST);
		expect(parseManifest('not json')).toEqual(EMPTY_MANIFEST);
		expect(parseManifest('{"version":2}')).toEqual(EMPTY_MANIFEST);
	});
});
