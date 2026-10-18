// THE SHARED SKILL RULES (AFB-20261018-0622): NAMES, THE FILE PARSER AND THE CONTENT HASH

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	MAX_SKILLS_PER_PROJECT,
	SKILL_BODY_MAX,
	isBuiltinSkillName,
	isSkillName,
	parseSkillFile,
	promptNameFor,
	skillNameFrom
} from '../../src/lib/shared/skills';
import { skillHash } from '../../src/lib/server/skills/hash';

// -- CONSTANTS -- //

const GOOD = `---
name: release-notes
description: How we write the release notes
---

Read the commits since the last tag.
`;

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

	it('refuses a file with no front matter, an unclosed one, and an unknown key', () => {
		expect(() => parseSkillFile('Just text.')).toThrow('front matter');
		expect(() => parseSkillFile('---\nname: x\n')).toThrow('not closed');
		expect(() => parseSkillFile('---\nname: x\nallowed-tools: yes\n---\n\nBody.')).toThrow(
			'Only name and description'
		);
	});

	it('refuses an anchor, an alias, a block value and a nested line', () => {
		expect(() => parseSkillFile('---\nname: x\ndescription: &a text\n---\n\nBody.')).toThrow(
			'Anchors and aliases'
		);
		expect(() => parseSkillFile('---\nname: x\ndescription: *a\n---\n\nBody.')).toThrow(
			'Anchors and aliases'
		);
		expect(() => parseSkillFile('---\nname: x\ndescription: |\n  two lines\n---\n\nBody.')).toThrow(
			'one line'
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
});
