// THE INSTALL PLANNER OF THE SYSTEM SKILLS (AFB-20261021-0803): ONE ACTION PER SKILL, AND "ASK" WHENEVER AN EDIT CANNOT BE RULED OUT

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { systemSkills } from '../../src/lib/server/system-skills';
import {
	HARNESSES,
	changelogCrossed,
	compareVersions,
	pageText,
	planSkills,
	skillsFolder,
	skillsNotice,
	type InstalledSkill,
	type ServedSkill
} from '../../src/lib/server/system-skills/plan';

// -- CONSTANTS -- //

const H = 'a'.repeat(64);
const served: ServedSkill[] = [
	{
		name: 'alpha',
		version: '1.2.0',
		files: [{ path: 'SKILL.md', sha256: 'f1', bytes: 10 }]
	},
	{
		name: 'beta',
		version: '2.0.0',
		files: [
			{ path: 'SKILL.md', sha256: 'f2', bytes: 20 },
			{ path: 'notes.md', sha256: 'f3', bytes: 30 }
		]
	}
];
const clean = (
	name: string,
	version: string,
	extra: Partial<InstalledSkill> = {}
): InstalledSkill => ({
	name,
	stampVersion: version,
	stampSha256: H,
	computedSha256: H,
	...extra
});
const plan = (installed: InstalledSkill[], name: string, checked = true) =>
	planSkills(served, 'claude-code', 'user', installed, checked).skills.find(
		(s) => s.name === name
	)!;
const action = (installed: InstalledSkill[], name: string) => plan(installed, name).action;

// -- TESTS -- //

describe('the folder of each harness', () => {
	it('knows the three tools with a skills folder and none for Codex or an unknown tool', () => {
		expect(skillsFolder('claude-code', 'user')).toBe('~/.claude/skills');
		expect(skillsFolder('claude-code', 'project')).toBe('.claude/skills');
		expect(skillsFolder('gemini-cli', 'user')).toBe('~/.gemini/skills');
		expect(skillsFolder('antigravity', 'project')).toBe('.agents/skills');
		expect(skillsFolder('codex', 'user')).toBeNull();
		expect(skillsFolder('other', 'project')).toBeNull();
		for (const h of HARNESSES)
			expect(['string', 'object']).toContain(typeof skillsFolder(h, 'user'));
	});

	it('puts the folder, or null, on the plan', () => {
		expect(planSkills(served, 'gemini-cli', 'project').folder).toBe('.gemini/skills');
		expect(planSkills(served, 'codex', 'user').folder).toBeNull();
	});
});

describe('comparing versions', () => {
	it('orders plain semver and gives NaN for anything else', () => {
		expect(compareVersions('1.0.9', '1.0.10')).toBeLessThan(0);
		expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
		expect(compareVersions('1.1.1', '1.1.1')).toBe(0);
		expect(compareVersions('1.1', '1.1.1')).toBeNaN();
		expect(compareVersions('v1.1.1', '1.1.1')).toBeNaN();
	});
});

describe('the action for one skill', () => {
	it('installs every skill when nothing is installed', () => {
		const all = planSkills(served, 'claude-code', 'user', [], true);
		expect(all.skills.map((s) => s.action)).toEqual(['install', 'install']);
		expect(all.skills[1].files.map((f) => f.path)).toEqual(['SKILL.md', 'notes.md']);
		expect(all.ignored).toBe(0);
	});

	it('asks about a skill nobody reported unless the agent says it listed the folder', () => {
		const unchecked = planSkills(served, 'claude-code', 'user');
		expect(unchecked.skills.map((s) => s.action)).toEqual(['ask', 'ask']);
		expect(unchecked.skills[0].reason).toContain('checked true');
		expect(plan([], 'alpha', true).reason).toBe('Not installed yet.');
	});

	it('leaves a skill at the served version, not edited, unchanged', () => {
		expect(action([clean('alpha', '1.2.0')], 'alpha')).toBe('unchanged');
	});

	it('updates an older skill that was not edited, and asks when it has supporting files nobody checked', () => {
		expect(action([clean('alpha', '1.0.0')], 'alpha')).toBe('update');
		expect(action([clean('beta', '1.0.0')], 'beta')).toBe('ask');
		expect(action([clean('beta', '1.0.0', { otherFilesChanged: false })], 'beta')).toBe('update');
	});

	it('asks when the SKILL.md was edited, even at the same version', () => {
		const edited = clean('alpha', '1.2.0', { computedSha256: 'b'.repeat(64) });
		expect(action([edited], 'alpha')).toBe('ask');
		expect(action([{ ...edited, stampVersion: '1.0.0' }], 'alpha')).toBe('ask');
	});

	it('asks when the agent did not hash the SKILL.md', () => {
		expect(action([{ name: 'alpha', stampVersion: '1.0.0', stampSha256: H }], 'alpha')).toBe('ask');
	});

	it('asks when there is no stamp, or the version is newer or not comparable', () => {
		expect(action([{ name: 'alpha' }], 'alpha')).toBe('ask');
		expect(action([clean('alpha', '9.0.0')], 'alpha')).toBe('ask');
		expect(action([clean('alpha', 'nightly')], 'alpha')).toBe('ask');
	});

	it('asks when a supporting file was edited, whether the agent said so or sent its hash', () => {
		expect(action([clean('beta', '2.0.0', { otherFilesChanged: true })], 'beta')).toBe('ask');
		const files = [{ path: 'notes.md', sha256: 'zz' }];
		expect(action([clean('beta', '2.0.0', { files })], 'beta')).toBe('ask');
		const same = [{ path: 'notes.md', sha256: 'f3' }];
		expect(action([clean('beta', '2.0.0', { files: same })], 'beta')).toBe('unchanged');
	});

	it('repairs a missing supporting file and asks about an unchecked one at the same version', () => {
		const other = [{ path: 'x.md', sha256: 'f9' }];
		expect(action([clean('beta', '2.0.0', { files: other })], 'beta')).toBe('update');
		expect(action([clean('beta', '2.0.0', { files: [] })], 'beta')).toBe('ask');
		expect(action([clean('beta', '2.0.0')], 'beta')).toBe('ask');
	});

	it('counts folders that are not bundle skills without naming them', () => {
		const plan = planSkills(served, 'claude-code', 'user', [
			clean('alpha', '1.2.0'),
			{ name: '../../etc' },
			{ name: 'mine' }
		]);
		expect(plan.ignored).toBe(2);
		expect(JSON.stringify(plan)).not.toContain('etc');
	});
});

describe('the plan over the real bundle', () => {
	it('lists every real skill with its files and never builds a path from input', () => {
		const real = systemSkills();
		const plan = planSkills(real, 'antigravity', 'user', [{ name: '..' }]);
		expect(plan.skills.map((s) => s.name)).toEqual(real.map((s) => s.name));
		for (const s of plan.skills) for (const f of s.files) expect(f.path).not.toContain('..');
		expect(plan.ignored).toBe(1);
	});
});

describe('the session notice about the skills', () => {
	it('stays quiet for a current or newer bundle', () => {
		expect(skillsNotice('1.1.1', '1.1.1')).toBeNull();
		expect(skillsNotice('1.2.0', '1.1.1')).toBeNull();
	});

	it('announces an update for an older bundle, and the install for none', () => {
		expect(skillsNotice('1.0.0', '1.1.1')).toContain('older than the served 1.1.1');
		expect(skillsNotice('none', '1.1.1')).toContain('not installed');
		expect(skillsNotice('none', '1.1.1')).toContain('flow_skills');
	});

	it('only hints when the field is missing or unreadable, never claiming the skills are absent', () => {
		for (const passed of [undefined, 'nightly', '']) {
			const text = skillsNotice(passed, '1.1.1') ?? '';
			expect(text).toContain('If no flow skill is in your skill list');
			// It only asks the agent to look: the server cannot know, so the whole line is a condition
			expect(text.startsWith('If no flow skill is in your skill list')).toBe(true);
			expect(text).toContain('ignore this line');
		}
	});
});

describe('the reason shown for each decision', () => {
	it('says why it asks, so the person is told the true cause', () => {
		const edited = clean('alpha', '1.2.0', { computedSha256: 'b'.repeat(64) });
		expect(plan([edited], 'alpha').reason).toContain('edited by hand');
		expect(plan([{ ...edited, stampVersion: '1.0.0' }], 'alpha').reason).toContain(
			'edited by hand'
		);
		expect(plan([{ name: 'alpha' }], 'alpha').reason).toContain('no bundle stamp');
		expect(plan([clean('alpha', '9.0.0')], 'alpha').reason).toContain('newer than the served');
		expect(plan([clean('alpha', 'nightly')], 'alpha').reason).toContain(
			'not one this bundle can compare'
		);
		const unhashed = { name: 'alpha', stampVersion: '1.0.0', stampSha256: H };
		expect(plan([unhashed], 'alpha').reason).toContain('was not hashed');
		expect(plan([clean('beta', '2.0.0')], 'beta').reason).toContain('not checked');
		expect(plan([clean('beta', '2.0.0', { otherFilesChanged: true })], 'beta').reason).toContain(
			'supporting file was edited'
		);
	});

	it('treats an empty files list as not reported, and a hash list at an older version as the agent check only', () => {
		const empty = plan([clean('beta', '2.0.0', { files: [] })], 'beta');
		expect(empty.action).toBe('ask');
		expect(empty.reason).toContain('not checked');
		const files = [{ path: 'notes.md', sha256: 'f3' }];
		expect(plan([clean('beta', '1.0.0', { files })], 'beta').action).toBe('ask');
		expect(plan([clean('beta', '1.0.0', { files, otherFilesChanged: false })], 'beta').action).toBe(
			'update'
		);
		const other = [{ path: 'x.md', sha256: 'f9' }];
		const missing = plan([clean('beta', '2.0.0', { files: other })], 'beta');
		expect(missing.action).toBe('update');
		expect(missing.reason).toContain('missing');
	});

	it('does not echo a version it cannot read', () => {
		expect(plan([clean('alpha', 'nightly')], 'alpha').installedVersion).toBeNull();
		expect(plan([clean('alpha', '1.0.0')], 'alpha').installedVersion).toBe('1.0.0');
	});
});

describe('the changelog an update crosses', () => {
	const log = [
		{ version: '1.2.0', date: 'd3', notes: ['n3'], skills: { alpha: '1.2.0', beta: '2.0.0' } },
		{ version: '1.1.0', date: 'd2', notes: ['n2'], skills: { alpha: '1.1.0', beta: '2.0.0' } },
		{ version: '1.0.0', date: 'd1', notes: ['n1'], skills: { alpha: '1.0.0', beta: '1.0.0' } }
	];

	it('lists the entries above the installed version up to the served one, and nothing for skills that stay', () => {
		const p = planSkills(served, 'claude-code', 'user', [clean('alpha', '1.0.0')], true);
		expect(changelogCrossed(log, p, served).map((c) => c.version)).toEqual(['1.2.0', '1.1.0']);
		// beta is unchanged in the 1.2.0 and 1.1.0 entries, so its update never quotes them
		const beta = planSkills(
			served,
			'claude-code',
			'user',
			[clean('beta', '1.0.0', { otherFilesChanged: false })],
			true
		);
		expect(changelogCrossed(log, beta, served).map((c) => c.version)).toEqual(['1.1.0']);
		const same = planSkills(served, 'claude-code', 'user', [clean('alpha', '1.2.0')], true);
		expect(changelogCrossed(log, same, served)).toEqual([]);
	});
});

describe('a skill reported twice', () => {
	it('is a question, and a repeated unknown folder is counted once', () => {
		const twice = [
			clean('alpha', '1.2.0'),
			clean('alpha', '1.2.0', { computedSha256: 'c'.repeat(64) })
		];
		expect(plan(twice, 'alpha').action).toBe('ask');
		expect(plan(twice, 'alpha').reason).toContain('twice');
		const p = planSkills(served, 'claude-code', 'user', [{ name: 'mine' }, { name: 'mine' }], true);
		expect(p.ignored).toBe(1);
	});
});

describe('paging a text', () => {
	it('never ends a part inside a surrogate pair, and the parts join to the text', () => {
		const t = 'a\u{1F600}b\u{1F600}c';
		expect(pageText(t, 0, 2)).toEqual({ text: 'a', next: 1 });
		let joined = '';
		let off: number | null = 0;
		while (off !== null) {
			const part: { text: string; next: number | null } = pageText(t, off, 2);
			joined += part.text;
			off = part.next;
		}
		expect(joined).toBe(t);
	});

	it('refuses an offset inside a pair, at the length and past it, and serves an empty text once', () => {
		const t = 'a\u{1F600}b';
		expect(() => pageText(t, 2, 2)).toThrow(/splits a character/);
		expect(() => pageText(t, t.length, 2)).toThrow(/past the end/);
		expect(() => pageText(t, 99, 2)).toThrow(/past the end/);
		expect(pageText('', 0, 2)).toEqual({ text: '', next: null });
	});
});
