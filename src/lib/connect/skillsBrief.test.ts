// THE SYSTEM SKILLS BRIEF (AFB-20261021-0401): THE RULES THE AGENT MUST BE TOLD, AND NOTHING SECRET

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { skillsBriefMarkdown } from './skillsBrief';
import { STAMP_KEYS } from '../server/system-skills/hash';
import { skillsFolder } from '../server/system-skills/plan';

// -- CONSTANTS -- //

const INDEX = {
	bundle: { version: '1.2.0', releasedAt: '2026-10-21' },
	skills: [
		{ name: 'flow', version: '1.2.0' },
		{ name: 'flow-critic', version: '1.0.1' }
	]
};
const brief = skillsBriefMarkdown('https://board.example.com', INDEX);

// -- TESTS -- //

describe('the system skills brief', () => {
	it('names the index, the zip, the file address and the release', () => {
		expect(brief).toContain('https://board.example.com/api/v1/system-skills\n');
		expect(brief).toContain('https://board.example.com/api/v1/system-skills/bundle.zip');
		expect(brief).toContain('/files/<skill name>/<file path>');
		expect(brief).toContain('Bundle 1.2.0, released 2026-10-21');
		expect(brief).toContain('- `flow-critic` 1.0.1');
	});

	it('tells the agent the update rules: install, skip, update when unedited, ask otherwise', () => {
		expect(brief).toContain('**Not there:** install the skill.');
		expect(brief).toContain('equals the index version');
		expect(brief).toContain('older than the index version');
		expect(brief).toContain('ask before you overwrite anything');
		for (const k of STAMP_KEYS) expect(brief, k).toContain(`${k}:`);
	});

	it('tells the agent to check every sha256, to use https only and never to run bundle content', () => {
		expect(brief).toContain('sha256 of each file you wrote');
		expect(brief).toContain('Use https only');
		expect(brief).toContain('http://localhost');
		expect(brief).toContain('Confirm with the person');
		expect(brief).toContain('Run, open or execute any script');
		expect(brief).toContain('Overwrite a file the person changed without asking');
	});

	it('names a skills folder for each tool and the workflow_get fallback', () => {
		for (const t of ['Claude Code', 'Gemini CLI', 'Antigravity', 'Codex'])
			expect(brief, t).toContain(`| ${t} |`);
		expect(brief).toContain('.claude/skills/<name>/');
		expect(brief).toContain('workflow_get');
	});

	it('holds no token, session id, cookie or personal address', () => {
		expect(brief).not.toMatch(/afb_[A-Za-z0-9]{16,}/);
		expect(brief).not.toMatch(/Bearer\s+\S{12,}/);
		expect(brief).not.toContain('@');
		expect(brief).toContain('Ask for, print or store a token');
	});

	it('names the two MCP tools first and keeps the file steps for a tool without them (AFB-20261021-0803)', () => {
		expect(brief).toContain('## If this tool has the Agent Flow Board MCP connected');
		expect(brief.indexOf('skills_check')).toBeLessThan(
			brief.indexOf('## What to do, in this order')
		);
		expect(brief).toContain('skills_file');
		expect(brief).toContain('use the addresses above');
	});

	it('gives every harness folder the same path as skills_check does', () => {
		for (const h of ['claude-code', 'gemini-cli', 'antigravity'] as const)
			for (const scope of ['user', 'project'] as const)
				expect(brief, `${h} ${scope}`).toContain(`${skillsFolder(h, scope)}/<name>/`);
	});
});
