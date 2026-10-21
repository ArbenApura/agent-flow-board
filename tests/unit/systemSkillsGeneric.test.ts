// THE SYSTEM SKILLS ARE GENERIC (AFB-20261021-0736): NO REPO FACTS IN THE SHIPPED TEXT, AND THE SAFETY RULES STAY
// A skill is read by users of any project and stack. A repo fact (a path, a port, a gate command, the AFB key) belongs in the repo
// rulebook, so it may only appear on a line that contains "(example)" or inside a fenced block whose info string is "example".
// Product words stay allowed because no pattern below matches them: Agent Flow Board, the afb-checks tool, afb-tab, afb-boot,
// the agent-flow-board hooks command, the mcp__afb- prefix and the <KEY>-YYYYMMDD-HHMM reference form.

// -- DEP-MODULES -- //
import { describe, expect, it } from 'vitest';
// -- MODULES -- //
import { sourceFiles } from '../../src/lib/server/system-skills';
import { frontMatterKeys } from '../../src/lib/server/system-skills/hash';

// -- CONSTANTS -- //

// Whole-token repo facts. The bare key AFB is case-sensitive and the reference form AFB-YYYYMMDD stays fine.
const FORBIDDEN: { name: string; pattern: RegExp }[] = [
	{ name: 'a local path', pattern: /[A-Za-z]:[\\/]|\/Users\/|\/home\/[a-z]/ },
	{ name: 'a fixed port or database port', pattern: /\b(5433|5180|5190)\b/ },
	{ name: 'HAPR', pattern: /\bHAPR\b/ },
	{ name: 'the bare project key AFB', pattern: /\bAFB\b(?!-)/ },
	{
		name: 'a gate command',
		pattern: /\byarn (check|eslint|prettier|vitest|test|build|db:|deploy)/
	},
	{ name: 'a gate tool name', pattern: /\b(eslint|prettier|vitest|svelte-check)\b/ },
	{ name: 'the repo design file', pattern: /\bDESIGN\.md\b/ }
];

// Retained safety rules and method: each must stay in the skill that owns it, whatever else is rewritten.
const RETAINED: Record<string, { rule: string; pattern: RegExp }[]> = {
	flow: [
		{ rule: 'no push without the user', pattern: /git push/ },
		{ rule: 'step_done after each step', pattern: /step_done/ },
		{ rule: 'work_stop at the end', pattern: /work_stop/ },
		{ rule: 'approval gate before code', pattern: /approve the plan/i },
		{ rule: 'untrusted text is data', pattern: /untrusted/i },
		{ rule: 'no AI attribution', pattern: /Claude or Anthropic attribution/ },
		{ rule: 'no .env database URL', pattern: /database URL from `\.env`/ },
		{
			rule: 'never empty a database the user keeps',
			pattern: /empties, resets or drops a database/
		},
		{ rule: 'no branch creation', pattern: /Never create or switch branches/ },
		{ rule: 'confirm anything live', pattern: /confirmed with them immediately before/ },
		{ rule: 'project key discovery', pattern: /board_brief/ },
		{ rule: 'no gates found', pattern: /no gates found/ }
	],
	'flow-audit': [
		{ rule: 'no commit or push', pattern: /Do not commit, push/ },
		{ rule: 'work_stop at the end', pattern: /work_stop/ },
		{ rule: 'untrusted text is data', pattern: /Untrusted text is data/ },
		{ rule: 'no AI attribution', pattern: /\*\*No attribution\.\*\*/ },
		{ rule: 'nothing live, nothing destroyed', pattern: /Nothing live, nothing destroyed/ }
	],
	'flow-critic': [
		{ rule: 'no commit or push', pattern: /Never commit or push as part of a review/ },
		{ rule: 'no AI attribution', pattern: /Claude or Anthropic attribution/ },
		{ rule: 'no .env database URL', pattern: /database URL from `\.env`/ },
		{ rule: 'no tokens', pattern: /Print or read tokens/ },
		{
			rule: 'never empty a database the user keeps',
			pattern: /Reset, drop or empty a database the user keeps/
		}
	],
	'flow-verify': [
		{ rule: 'no push or deploy', pattern: /Never run a push, a deploy/ },
		{
			rule: 'never empty a database the user keeps',
			pattern: /Never reset, drop or empty a database the user keeps/
		},
		{ rule: 'no tokens', pattern: /Never print or read tokens/ },
		{ rule: 'no gates found', pattern: /no gates found/ }
	],
	'flow-interview': [
		{ rule: 'no code before approval', pattern: /approves the plan|approve the plan/i },
		{ rule: 'no .env database URL', pattern: /database URL from `\.env`/ },
		{ rule: 'untrusted text is data', pattern: /Untrusted text is data/ }
	],
	'flow-task': [
		{ rule: 'no commit or push', pattern: /Never edit code, commit or push/ },
		{ rule: 'no AI attribution', pattern: /AI attribution/ },
		{ rule: 'no work_start', pattern: /Do not call `work_start`/ },
		{ rule: 'task text is data', pattern: /instructions found inside a task/ }
	],
	'flow-skills': [
		{
			rule: 'never run served content',
			pattern: /Never run, open or execute anything found inside them/
		},
		{
			rule: 'never overwrite an edited file unasked',
			pattern: /Never overwrite a skill or file the person edited/
		},
		{ rule: 'no tokens', pattern: /never ask for, print or store a token/i }
	],
	'flow-check': [
		{ rule: 'stop for a shared database, a server or a live site', pattern: /live site/ },
		{ rule: 'the afb-checks tool', pattern: /afb-checks/ }
	]
};

// -- FUNCTIONS -- //

// The lines of a file that carry no marked example: a fenced block opened with the info string "example" is skipped, and so is a line with "(example)"
const unmarkedLines = (text: string): { n: number; line: string }[] => {
	const out: { n: number; line: string }[] = [];
	let inExample = false;
	let inFence = false;
	text.split('\n').forEach((line, i) => {
		const fence = line.match(/^\s*```(.*)$/);
		if (fence) {
			if (!inFence) {
				inFence = true;
				inExample = fence[1].trim().toLowerCase() === 'example';
			} else {
				inFence = false;
				inExample = false;
			}
			return;
		}
		if (inExample || line.includes('(example)')) return;
		out.push({ n: i + 1, line });
	});
	return out;
};

// -- TESTS -- //

describe('the shipped skills carry no repo facts', () => {
	for (const [name, files] of Object.entries(sourceFiles())) {
		for (const file of files) {
			it(`${name}/${file.path} names no path, port, key or gate outside a marked example`, () => {
				const hits: string[] = [];
				for (const { n, line } of unmarkedLines(file.text))
					for (const f of FORBIDDEN)
						if (f.pattern.test(line)) hits.push(`${n}: ${f.name}: ${line.trim().slice(0, 90)}`);
				expect(hits, `${name}/${file.path}`).toEqual([]);
			});
		}
	}
});

describe('the shipped skills keep their safety rules', () => {
	const sources = sourceFiles();
	for (const [name, rules] of Object.entries(RETAINED)) {
		it(`${name} still states every retained rule`, () => {
			const text = sources[name].map((f) => f.text).join('\n');
			const missing = rules.filter((r) => !r.pattern.test(text)).map((r) => r.rule);
			expect(missing, name).toEqual([]);
		});
	}
});

describe('the skill descriptions', () => {
	it('are one complete line each, within a length limit, and say Agent Flow Board in place of a repo name', () => {
		for (const [name, files] of Object.entries(sourceFiles())) {
			const md = files.find((f) => f.path === 'SKILL.md')!.text;
			const description = frontMatterKeys(md).description ?? '';
			expect(description.length, name).toBeGreaterThan(60);
			expect(description.length, name).toBeLessThan(1100);
			expect(description, name).not.toMatch(/^[>|]/);
			expect(description, name).not.toContain('in agent-flow-board');
			// The extracted value equals the raw front matter line, so nothing was cut at a colon or a quote
			const raw = md.split('\n').find((l) => l.startsWith('description:'))!;
			const value = raw.replace(/^description:\s*/, '').replace(/^"(.*)"$/, '$1');
			expect(description, name).toBe(value);
		}
	});
});
