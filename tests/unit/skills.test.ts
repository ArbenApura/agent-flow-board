// THE SHARED SKILL RULES (AFB-20261018-0622): NAMES, THE FILE PARSER AND THE CONTENT HASH

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	MAX_SKILLS_PER_PROJECT,
	SKILL_BODY_MAX,
	SKILL_FILE_BODY_MAX,
	SKILL_FILE_PATH_MAX,
	SKILL_FILES_MAX,
	SKILL_TOTAL_MAX,
	isBuiltinSkillName,
	isSkillName,
	parseSkillFile,
	promptNameFor,
	readSkillPicks,
	skillFilePathError,
	skillFilesError,
	skillNameFrom,
	sortSkillFiles
} from '../../src/lib/shared/skills';
import { skillHash } from '../../src/lib/server/skills/hash';

// -- CONSTANTS -- //

const GOOD = `---
name: release-notes
description: How we write the release notes
---

Read the commits since the last tag.
`;

const GOLDEN_NO_FILES = '5980b4ad0796bac403ef0ce3b4178e6ff0f486f7ff8b0acf9a69212fdc2b3738';
const GOLDEN_FILES = 'bc3632dd6d647067c2338388f2ac4159de3078b7bcb9a52abdc78d85b3d5626d';

// -- TESTS -- //

describe('skill names', () => {
	it('accepts a lowercase slug and refuses the five built-ins', () => {
		expect(isSkillName('release-notes')).toBe(true);
		expect(isSkillName('notes2')).toBe(true);
		expect(isSkillName('Release-Notes')).toBe(false);
		expect(isSkillName('-notes')).toBe(false);
		expect(isSkillName('notes--two')).toBe(false);
		for (const name of ['flow', 'flow-task', 'flow-interview', 'flow-critic', 'flow-audit']) {
			expect(isBuiltinSkillName(name)).toBe(true);
			expect(isSkillName(name)).toBe(false);
		}
	});

	it('slugs a title and prefixes a prompt with the project key', () => {
		expect(skillNameFrom('Release Notes!')).toBe('release-notes');
		expect(skillNameFrom('  --Weird  Title--  ')).toBe('weird-title');
		expect(promptNameFor('AFB', 'release-notes')).toBe('afb-release-notes');
	});

	it('keeps the prompt list small', () => {
		expect(MAX_SKILLS_PER_PROJECT).toBe(50);
		expect(SKILL_BODY_MAX).toBe(100_000);
	});
});

describe('SKILL.md', () => {
	it('reads the flat name and description and keeps the body', () => {
		const file = parseSkillFile(GOOD);
		expect(file.name).toBe('release-notes');
		expect(file.summary).toBe('How we write the release notes');
		expect(file.body).toBe('Read the commits since the last tag.');
	});

	it('accepts quotes around a value and a Windows line ending', () => {
		const file = parseSkillFile(
			'---\r\nname: "quoted"\r\ndescription: \'Single quoted\'\r\n---\r\n\r\nBody.'
		);
		expect(file.name).toBe('quoted');
		expect(file.summary).toBe('Single quoted');
		expect(file.body).toBe('Body.');
	});

	it('refuses a file with no front matter and an unclosed one', () => {
		expect(() => parseSkillFile('Just text.')).toThrow('front matter');
		expect(() => parseSkillFile('---\nname: x\n')).toThrow('not closed');
	});

	it('skips other flat keys such as disable-model-invocation', () => {
		const file = parseSkillFile(
			'---\nname: x\ndescription: Does x\ndisable-model-invocation: true\nallowed-tools: yes\n---\n\nBody.'
		);
		expect(file).toEqual({ name: 'x', summary: 'Does x', body: 'Body.' });
		expect(() => parseSkillFile('---\nname: x\nallowed-tools:\n  inner: y\n---\n\nBody.')).toThrow(
			'nested'
		);
	});

	it('folds a block description into one line, as a folded or a literal block', () => {
		const folded = parseSkillFile(
			'---\nname: x\ndescription: >\n    Enforces coding rules,\n    covers "quotes" and: colons.\n\n    Second part.\nallowed-tools: >-\n  a b\n---\n\nBody.'
		);
		expect(folded.summary).toBe('Enforces coding rules, covers "quotes" and: colons. Second part.');
		expect(folded.body).toBe('Body.');
		expect(parseSkillFile('---\nname: x\ndescription: |-\n  one\n  two\n---\n\nB.').summary).toBe(
			'one two'
		);
		// A block under a key that is skipped does not turn its lines into keys
		expect(
			parseSkillFile('---\nname: x\ndescription: d\nnotes: |\n  a: b\n---\n\nB.').summary
		).toBe('d');
		expect(() => parseSkillFile('---\nname: x\ndescription: >\n---\n\nBody.')).toThrow('empty');
	});

	it('refuses an anchor, an alias and a nested line', () => {
		expect(() => parseSkillFile('---\nname: x\ndescription: &a text\n---\n\nBody.')).toThrow(
			'Anchors and aliases'
		);
		expect(() => parseSkillFile('---\nname: x\ndescription: *a\n---\n\nBody.')).toThrow(
			'Anchors and aliases'
		);
		expect(() => parseSkillFile('---\nname: x\ndescription:\n  inner: y\n---\n\nBody.')).toThrow();
	});

	it('requires a name and keeps the body under the cap', () => {
		expect(() => parseSkillFile('---\ndescription: no name\n---\n\nBody.')).toThrow('needs a name');
		const huge = `---\nname: x\ndescription: d\n---\n\n${'x'.repeat(SKILL_BODY_MAX + 1)}`;
		expect(() => parseSkillFile(huge)).toThrow('longer than');
	});
});

describe('skill hash', () => {
	it('changes when the name, the summary or the body changes, and never otherwise', () => {
		const base = { name: 'a', summary: 'b', body: 'c' };
		const h = skillHash(base);
		expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(skillHash({ ...base })).toBe(h);
		expect(skillHash({ ...base, body: 'd' })).not.toBe(h);
		expect(skillHash({ ...base, summary: 'd' })).not.toBe(h);
		expect(skillHash({ ...base, name: 'd' })).not.toBe(h);
	});

	// The same two vectors are asserted by the bridge's own copy of this hash (packages/bridge), so the two cannot drift
	it('matches the golden vectors, with and without files, in any file order', () => {
		const skill = { name: 'release-notes', summary: 'How we write', body: 'Read the commits.' };
		expect(skillHash(skill)).toBe(GOLDEN_NO_FILES);
		expect(skillHash(skill, [])).toBe(GOLDEN_NO_FILES);
		const files = [
			{ path: 'refs/zeta.md', body: 'Zeta text.' },
			{ path: 'design-fit.md', body: 'Design text.' }
		];
		expect(skillHash(skill, files)).toBe(GOLDEN_FILES);
		expect(skillHash(skill, [...files].reverse())).toBe(GOLDEN_FILES);
		expect(skillHash(skill, [files[0]])).not.toBe(GOLDEN_FILES);
	});
});

describe('skill supporting files', () => {
	it('accepts a relative Markdown path and refuses one that could leave the skill folder', () => {
		for (const ok of ['design-fit.md', 'refs/a.md', 'a/b/c.MD'])
			expect(skillFilePathError(ok), ok).toBeNull();
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
			`${'a'.repeat(SKILL_FILE_PATH_MAX)}.md`
		];
		for (const path of bad) expect(skillFilePathError(path), path).not.toBeNull();
	});

	it('counts the body and every file together, and names what is wrong', () => {
		const file = (path: string, n = 5) => ({ path, body: 'x'.repeat(n) });
		expect(skillFilesError('body', [file('a.md'), file('b.md')])).toBeNull();
		expect(skillFilesError('body', [file('a.md'), file('A.md')])).toContain('twice');
		expect(skillFilesError('body', [file('a.md', 0)])).toContain('empty');
		expect(skillFilesError('body', [file('a.md', SKILL_FILE_BODY_MAX + 1)])).toContain('longer');
		const many = Array.from({ length: SKILL_FILES_MAX + 1 }, (_, i) => file(`f${i}.md`));
		expect(skillFilesError('body', many)).toContain(`${SKILL_FILES_MAX}`);
		const three = ['a', 'b', 'c'].map((n) => file(`${n}.md`, SKILL_FILE_BODY_MAX));
		expect(skillFilesError('x', three)).toContain(`${SKILL_TOTAL_MAX}`);
		expect(skillFilesError('', three)).toBeNull();
	});

	it('keeps files in path order', () => {
		const sorted = sortSkillFiles([
			{ path: 'b.md', body: '1' },
			{ path: 'a/z.md', body: '2' },
			{ path: 'a.md', body: '3' }
		]);
		expect(sorted.map((f) => f.path)).toEqual(['a.md', 'a/z.md', 'b.md']);
	});
});

describe('picked skill files', () => {
	const SKILL =
		'---\nname: coding-guidelines\ndescription: How we code\n---\n\nRead design-fit.md.\n';

	it('takes the SKILL.md as the skill and every other Markdown file as a supporting file', () => {
		const read = readSkillPicks(
			[
				{ name: 'design-fit.md', text: 'Design.\r\n' },
				{ name: 'SKILL.md', text: '\uFEFF' + SKILL },
				{ name: 'refs/forms.md', text: 'Forms.' }
			],
			{ needSkill: true }
		);
		expect(read.problems).toEqual([]);
		expect(read.skill?.name).toBe('coding-guidelines');
		expect(read.files).toEqual([
			{ path: 'design-fit.md', body: 'Design.\n' },
			{ path: 'refs/forms.md', body: 'Forms.' }
		]);
	});

	it('drops the folder name a folder pick puts in front of every file', () => {
		const read = readSkillPicks(
			[
				{ name: 'coding-guidelines/SKILL.md', text: SKILL },
				{ name: 'coding-guidelines/design-fit.md', text: 'Design.' }
			],
			{ needSkill: true }
		);
		expect(read.skill?.name).toBe('coding-guidelines');
		expect(read.files.map((f) => f.path)).toEqual(['design-fit.md']);
	});

	it('names each pick it leaves out instead of dropping it silently', () => {
		const read = readSkillPicks(
			[
				{ name: 'SKILL.md', text: SKILL },
				{ name: 'notes.txt', text: 'Not Markdown.' },
				{ name: 'empty.md', text: '  \n' },
				{ name: '../escape.md', text: 'Out.' },
				{ name: 'a.md', text: 'One.' },
				{ name: 'A.md', text: 'Two.' }
			],
			{ needSkill: true }
		);
		expect(read.files.map((f) => f.path)).toEqual(['a.md']);
		expect(read.problems).toHaveLength(4);
		expect(read.problems.join(' ')).toContain('notes.txt');
		expect(read.problems.join(' ')).toContain('empty.md');
		expect(read.problems.join(' ')).toContain('picked twice');
	});

	it('refuses a pick with no SKILL.md or two of them when a skill is needed', () => {
		expect(readSkillPicks([{ name: 'a.md', text: 'One.' }], { needSkill: true }).skill).toBeNull();
		expect(
			readSkillPicks([{ name: 'a.md', text: 'One.' }], { needSkill: true }).problems.join(' ')
		).toContain('SKILL.md');
		const two = readSkillPicks(
			[
				{ name: 'SKILL.md', text: SKILL },
				{ name: 'skill.md', text: SKILL }
			],
			{ needSkill: true }
		);
		expect(two.skill).toBeNull();
		expect(two.problems.join(' ')).toContain('More than one');
		const bad = readSkillPicks([{ name: 'SKILL.md', text: 'No front matter.' }], {
			needSkill: true
		});
		expect(bad.skill).toBeNull();
		expect(bad.problems).toHaveLength(1);
	});

	it('leaves a SKILL.md out of the files when only files are being added', () => {
		const read = readSkillPicks(
			[
				{ name: 'SKILL.md', text: SKILL },
				{ name: 'extra.md', text: 'Extra.' }
			],
			{ needSkill: false }
		);
		expect(read.skill).toBeNull();
		expect(read.files.map((f) => f.path)).toEqual(['extra.md']);
		expect(read.problems.join(' ')).toContain('SKILL.md');
	});
});
