import { describe, expect, it } from 'vitest';
import { SKILL_INFO, SKILL_KINDS, filterSkills, skillInfo } from '../../src/lib/connect/skillKinds';
import { systemSkillsIndex } from '../../src/lib/server/system-skills/index';

describe('skill kinds of the Skills tab', () => {
	it('has an entry for every skill the bundle ships', () => {
		const shipped = systemSkillsIndex().skills.map((s) => s.name);
		for (const name of shipped) expect(SKILL_INFO[name], name).toBeDefined();
	});
	it('names no skill the bundle does not ship', () => {
		const shipped = new Set(systemSkillsIndex().skills.map((s) => s.name));
		for (const name of Object.keys(SKILL_INFO)) expect(shipped.has(name), name).toBe(true);
	});
	it('puts every entry in a kind the chips offer', () => {
		for (const [name, info] of Object.entries(SKILL_INFO))
			expect(SKILL_KINDS, name).toContain(info.kind);
	});
	it('shows an unknown skill as Other with its own first sentence', () => {
		const info = skillInfo('flow-new', 'Does a new thing. Then it does more. And more.');
		expect(info.kind).toBe('Other');
		expect(info.summary).toBe('Does a new thing.');
	});
	it('keeps a long first sentence short', () => {
		const info = skillInfo('flow-new', `${'word '.repeat(60)}end.`);
		expect(info.summary.length).toBeLessThanOrEqual(140);
	});
	it('filters by kind and by a word in the name or the line, in any case', () => {
		const rows = Object.entries(SKILL_INFO).map(([name, i]) => ({ name, ...i }));
		expect(filterSkills(rows, 'All', '')).toHaveLength(rows.length);
		expect(filterSkills(rows, 'Design', '').map((r) => r.name)).toEqual(['flow-mockup']);
		expect(filterSkills(rows, 'All', 'MOCKUP').map((r) => r.name)).toContain('flow-mockup');
		// The kind and the word both have to match
		expect(filterSkills(rows, 'Setup', 'mockup')).toEqual([]);
		expect(filterSkills(rows, 'All', 'no such word anywhere')).toEqual([]);
		expect(
			filterSkills(rows, 'All', '  critic  ')
				.map((r) => r.name)
				.sort()
		).toEqual([
			'flow-critic-code',
			'flow-critic-mockup',
			'flow-critic-plan',
			'flow-critic-screens'
		]);
	});
});
