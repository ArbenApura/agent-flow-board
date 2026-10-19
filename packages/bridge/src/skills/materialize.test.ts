// THE BRIDGE'S SKILL FILES (AFB-20261018-0622): THE THREE TARGETS, THE MANIFEST AND HAND EDIT DRIFT

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	EMPTY_MANIFEST,
	MANIFEST_PATH,
	TARGETS,
	TARGET_NAMES,
	contentHash,
	filePathError,
	manifestText,
	parseManifest,
	planSkills,
	skillDir,
	skillFileText,
	skillHashOf,
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

// -- SUPPORTING FILES -- //

const GUIDE: RemoteSkill = {
	name: 'coding-guidelines',
	summary: 'How we code',
	body: 'Read design-fit.md first.',
	hash: '',
	files: [
		{ path: 'refs/zeta.md', body: 'Zeta text.' },
		{ path: 'design-fit.md', body: 'Design text.' }
	]
};
GUIDE.hash = skillHashOf(GUIDE, GUIDE.files);

describe('skill supporting files', () => {
	// The same two values are asserted by the board's own hash in tests/unit/skills.test.ts, so the two copies cannot drift
	it('hash the same as the board does, with and without files', () => {
		const skill = { name: 'release-notes', summary: 'How we write', body: 'Read the commits.' };
		expect(skillHashOf(skill)).toBe(
			'5980b4ad0796bac403ef0ce3b4178e6ff0f486f7ff8b0acf9a69212fdc2b3738'
		);
		const files = [
			{ path: 'refs/zeta.md', body: 'Zeta text.' },
			{ path: 'design-fit.md', body: 'Design text.' }
		];
		const golden = 'bc3632dd6d647067c2338388f2ac4159de3078b7bcb9a52abdc78d85b3d5626d';
		expect(skillHashOf(skill, files)).toBe(golden);
		expect(skillHashOf(skill, [...files].reverse())).toBe(golden);
	});

	// The same lists are asserted by the board's path rule in tests/unit/skills.test.ts
	it('refuse the paths the board refuses, and accept the ones it accepts', () => {
		for (const ok of ['design-fit.md', 'refs/a.md', 'a/b/c.MD'])
			expect(filePathError(ok), ok).toBeNull();
		const bad = [
			'',
			'/x.md',
			'../x.md',
			'a/../x.md',
			'./x.md',
			'a//x.md',
			'a\\x.md',
			'C:/x.md',
			'x.txt',
			'x',
			'SKILL.md',
			'skill.md',
			'con.md',
			'a/NUL.md',
			'x\u0000.md',
			'dot..md.',
			`${'a'.repeat(120)}.md`
		];
		for (const path of bad) expect(filePathError(path), path).not.toBeNull();
	});

	it('write each file beside the SKILL.md of every tool, and record each in the manifest', () => {
		const d = disk();
		const plan = planSkills([GUIDE], EMPTY_MANIFEST, d.read);
		apply(d, plan);
		for (const target of TARGET_NAMES) {
			const dir = skillDir(target, 'coding-guidelines');
			expect(d.get(`${dir}/design-fit.md`), target).toBe('Design text.\n');
			expect(d.get(`${dir}/refs/zeta.md`), target).toBe('Zeta text.\n');
		}
		expect(plan.files.filter((f) => f.action === 'create')).toHaveLength(9);
		const recorded = parseManifest(d.get(MANIFEST_PATH)).skills['coding-guidelines'];
		expect(recorded.hash).toBe(GUIDE.hash);
		expect(Object.keys(recorded.files)).toHaveLength(9);
		// Nothing to do on the next run
		expect(
			planSkills([GUIDE], parseManifest(d.get(MANIFEST_PATH)), d.read).files.every(
				(f) => f.action === 'unchanged'
			)
		).toBe(true);
	});

	it('update a file whose text changed on the board, and leave the other files alone', () => {
		const d = disk();
		apply(d, planSkills([GUIDE], EMPTY_MANIFEST, d.read));
		const changed: RemoteSkill = {
			...GUIDE,
			files: [
				{ path: 'refs/zeta.md', body: 'Zeta text.' },
				{ path: 'design-fit.md', body: 'New design text.' }
			]
		};
		changed.hash = skillHashOf(changed, changed.files);
		const plan = planSkills([changed], parseManifest(d.get(MANIFEST_PATH)), d.read);
		expect(
			plan.files.filter((f) => f.action === 'update').map((f) => f.path.split('/').pop())
		).toEqual(['design-fit.md', 'design-fit.md', 'design-fit.md']);
		apply(d, plan);
		expect(d.get('.claude/skills/coding-guidelines/design-fit.md')).toBe('New design text.\n');
	});

	it('remove a file the board no longer has while it is still ours, and keep one somebody edited', () => {
		const d = disk();
		apply(d, planSkills([GUIDE], EMPTY_MANIFEST, d.read));
		const fewer: RemoteSkill = {
			...GUIDE,
			files: [{ path: 'design-fit.md', body: 'Design text.' }]
		};
		fewer.hash = skillHashOf(fewer, fewer.files);
		// One tool's copy was edited by hand, the other two are untouched
		const edited = '.claude/skills/coding-guidelines/refs/zeta.md';
		d.write(edited, 'A person edited this file.');
		const plan = planSkills([fewer], parseManifest(d.get(MANIFEST_PATH)), d.read);
		const zeta = plan.files.filter((f) => f.path.endsWith('refs/zeta.md'));
		expect(zeta.find((f) => f.path === edited)?.action).toBe('drift');
		expect(zeta.filter((f) => f.action === 'remove')).toHaveLength(2);
		apply(d, plan);
		expect(d.get(edited)).toBe('A person edited this file.');
		expect(d.has('.agents/skills/coding-guidelines/refs/zeta.md')).toBe(false);
		// The hand edit stays on record, and the removed copies do not come back as ghosts in the manifest
		const files = parseManifest(d.get(MANIFEST_PATH)).skills['coding-guidelines'].files;
		expect(Object.keys(files).filter((p) => p.endsWith('refs/zeta.md'))).toEqual([edited]);
	});

	it('remove every file of a skill the board no longer has', () => {
		const d = disk();
		apply(d, planSkills([GUIDE], EMPTY_MANIFEST, d.read));
		const plan = planSkills([], parseManifest(d.get(MANIFEST_PATH)), d.read);
		expect(plan.files.filter((f) => f.action === 'remove')).toHaveLength(9);
		apply(d, plan);
		expect(d.has('.gemini/skills/coding-guidelines/refs/zeta.md')).toBe(false);
	});

	it('stop the whole run on a path that could leave the skill folder', () => {
		const d = disk();
		for (const path of ['../../.git/hooks/pre-commit.md', '/etc/x.md', 'a/../../b.md', 'C:/x.md']) {
			const evil: RemoteSkill = { ...GUIDE, files: [{ path, body: 'Out.' }] };
			expect(() => planSkills([evil], EMPTY_MANIFEST, d.read), path).toThrow('not safe');
		}
	});

	it('write a skill from a board without files exactly as before', () => {
		const d = disk();
		const plan = planSkills([NOTES], EMPTY_MANIFEST, d.read);
		expect(plan.files).toHaveLength(3);
		expect(plan.manifest.skills['release-notes'].hash).toBe(NOTES.hash);
	});
});
