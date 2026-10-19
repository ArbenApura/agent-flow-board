// THE TRACKED COPIES OF THE REPO'S OWN SKILLS (AFB-20261018-0622, ADR 6)
// .claude/ and .agents/ are outside git, so the MCP serves copies kept in src/lib/server/mcp/workflow-docs. This module
// strips the front matter, hashes the result and writes both the copies and the manifest the CI test checks.

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// -- TYPES -- //

export type SkillSource = { file: string; skill: string; source: string };
export type ManifestEntry = SkillSource & { hash: string };

// -- CONSTANTS -- //

/** Where the served copies live, and where the manifest sits beside them. */
export const DOCS_DIR = join(process.cwd(), 'src', 'lib', 'server', 'mcp', 'workflow-docs');
export const MANIFEST_FILE = join(DOCS_DIR, 'manifest.json');

/** The repo's own skill files, and the served copy each one becomes. */
export const SKILL_SOURCES: SkillSource[] = [
	{ file: 'flow.md', skill: 'flow', source: '.claude/skills/flow/SKILL.md' },
	{ file: 'flow-task.md', skill: 'flow-task', source: '.claude/skills/flow-task/SKILL.md' },
	{
		file: 'flow-interview.md',
		skill: 'flow-interview',
		source: '.claude/skills/flow-interview/SKILL.md'
	},
	{ file: 'flow-critic.md', skill: 'flow-critic', source: '.claude/skills/flow-critic/SKILL.md' },
	{ file: 'flow-audit.md', skill: 'flow-audit', source: '.claude/skills/flow-audit/SKILL.md' },
	{ file: 'flow-check.md', skill: 'flow-check', source: '.claude/skills/flow-check/SKILL.md' },
	{ file: 'flow-verify.md', skill: 'flow-verify', source: '.claude/skills/flow-verify/SKILL.md' },
	{
		file: 'critic-checklists.md',
		skill: 'flow-critic',
		source: '.claude/skills/flow-critic/checklists.md'
	},
	{
		file: 'critic-code-lenses.md',
		skill: 'flow-critic',
		source: '.claude/skills/flow-critic/code-lenses.md'
	},
	{
		file: 'critic-code-template.md',
		skill: 'flow-critic',
		source: '.claude/skills/flow-critic/code-template.md'
	},
	{
		file: 'critic-plan-lenses.md',
		skill: 'flow-critic',
		source: '.claude/skills/flow-critic/plan-lenses.md'
	},
	{
		file: 'critic-plan-template.md',
		skill: 'flow-critic',
		source: '.claude/skills/flow-critic/plan-template.md'
	}
];

// -- FUNCTIONS -- //

/** The served text: the skill without its YAML front matter, LF line endings, one trailing newline. */
export function stripFrontMatter(raw: string): string {
	const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
	if (!text.startsWith('---\n')) return `${text.trimEnd()}\n`;
	const end = text.indexOf('\n---', 3);
	if (end < 0) throw new Error('A SKILL.md front matter is not closed.');
	return `${text
		.slice(end + 4)
		.replace(/^\n+/, '')
		.trimEnd()}\n`;
}

export const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

export const readDoc = (file: string) => readFileSync(join(DOCS_DIR, file), 'utf8');

/** Writes every served copy and the manifest, and returns the entries it wrote. */
export function syncSkills(): ManifestEntry[] {
	mkdirSync(DOCS_DIR, { recursive: true });
	const entries = SKILL_SOURCES.map(({ file, skill, source }) => {
		const text = stripFrontMatter(readFileSync(join(process.cwd(), source), 'utf8'));
		writeFileSync(join(DOCS_DIR, file), text);
		return { file, skill, source, hash: hashOf(text) };
	});
	writeFileSync(MANIFEST_FILE, `${JSON.stringify({ version: 1, files: entries }, null, '\t')}\n`);
	return entries;
}
