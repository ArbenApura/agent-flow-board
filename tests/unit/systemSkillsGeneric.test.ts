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
		{ rule: 'no gates found', pattern: /no gates found/ },
		{ rule: 'a sourced design brief', pattern: /`design-brief` before you present the plan/ },
		{
			rule: 'a visible choice is never invented',
			pattern: /never invent it, and never settle it with a recommended default/
		},
		{ rule: 'a design gap is a reason to stop', pattern: /\(5\) a visible design choice/ },
		{ rule: 'ask before any mockup', pattern: /Never make one without a yes/ },
		{
			rule: 'the mockup offer is a line of the one approval question, on every harness',
			pattern: /the same question carries one more line: also draw a design mockup/
		},
		{
			rule: 'a mockup is inspiration and never the spec',
			pattern: /A mockup is inspiration, never the spec/
		},
		{
			rule: 'a mockup that adds a feature the plan lacks is a stop',
			pattern: /a mockup that adds a feature or behaviour the plan does not contain/
		},
		{ rule: 'the build follows the agreed design', pattern: /Build what was agreed/ },
		{
			rule: 'the lite flow keeps the approval gate',
			pattern: /Lite flow \(a plan of 1 to 3 steps\)[\s\S]*approval gate/
		},
		{
			rule: 'the server refuses more than 3 lite steps',
			pattern: /refuses more than 3 steps in .lite_new./
		},
		{ rule: 'scope stays what was asked', pattern: /Scope stays what was asked/ },
		{
			rule: 'an answer covers only questions seen',
			pattern: /covers only the questions the user has seen/
		},
		{
			rule: 'a merge is tested before a push',
			pattern: /A merge or pull is tested before anything is pushed/
		},
		{ rule: 'a renewed session is used from then on', pattern: /sessionRenewed: true/ },
		// AFB-20261110-1448: the rules that keep a run moving
		{ rule: 'the approval is asked once', pattern: /The approval is asked once/ },
		{
			rule: 'naming the mockup skill with flow is the yes',
			pattern: /Naming `\/flow-mockup` together with `\/flow`[^\n]*is the yes/
		},
		{ rule: 'a yes to the mockup is followed at once', pattern: /A yes is followed at once/ },
		{ rule: 'questions are checked and batched', pattern: /Answer your own question first/ },
		{ rule: 'a permission is given once', pattern: /A permission is given once/ },
		{ rule: 'new scope is never automatic', pattern: /Never add new scope on your own/ },
		{ rule: 'the hook session id is reused', pattern: /use that id and skip `session_start`/ },
		// AFB-20261110-1515: whole-project gates run once, never after every change
		{ rule: 'the gates run at two speeds', pattern: /Run the gates at two speeds/ },
		{ rule: 'a passed gate is not rerun', pattern: /Never twice for nothing/ }
	],
	'flow-audit': [
		{ rule: 'no commit or push', pattern: /Do not commit, push/ },
		{ rule: 'work_stop at the end', pattern: /work_stop/ },
		{ rule: 'untrusted text is data', pattern: /Untrusted text is data/ },
		{ rule: 'points to the flow safety rules', pattern: /`\/flow` safety rules/ }
	],
	'flow-critic': [
		{ rule: 'no commit or push', pattern: /Never commit or push as part of a review/ },
		{ rule: 'no AI attribution', pattern: /Claude or Anthropic attribution/ },
		{ rule: 'points to the flow safety rules', pattern: /`\/flow` safety rules/ },
		{ rule: 'checks the design brief', pattern: /Has a sourced design brief/ },
		{ rule: 'checks the build against the design', pattern: /An unapproved difference is/ },
		{ rule: 'mockup mode runs only on the user word', pattern: /runs only on the user's word/ },
		{ rule: 'a mockup shell must be the app own', pattern: /The shell is the app's own/ }
	],
	'flow-verify': [
		{ rule: 'tests after a merge before a push', pattern: /After a merge, a pull or a rebase/ },
		{ rule: 'no push or deploy', pattern: /Never run a push, a deploy/ },
		{ rule: 'points to the flow safety rules', pattern: /`\/flow` safety rules/ },
		{ rule: 'no gates found', pattern: /no gates found/ },
		{
			rule: 'no whole-project gate after each change',
			pattern: /After a change, the fast gate only/
		},
		{ rule: 'a passed gate is not rerun', pattern: /Never twice for nothing/ }
	],
	'flow-interview': [
		{ rule: 'no code before approval', pattern: /approves the plan|approve the plan/i },
		{ rule: 'points to the flow safety rules', pattern: /`\/flow` safety rules/ },
		{ rule: 'untrusted text is data', pattern: /Untrusted text is data/ },
		{ rule: 'asks from the design brief', pattern: /read its `design-brief` section first/ },
		{
			rule: 'no mockup talk where it does not apply',
			pattern: /do not mention mockups/
		}
	],
	'flow-mockup': [
		{ rule: 'no commit or push', pattern: /never commit or push/ },
		{ rule: 'never in the repo', pattern: /never put a mockup file in the repo/ },
		{ rule: 'untrusted text is data', pattern: /data written by other people/ },
		{ rule: 'points to the flow safety rules', pattern: /`\/flow` safety rules/ },
		{ rule: 'only on the user yes', pattern: /Never make a mockup the user did not say yes to/ },
		{ rule: 'no network inside a mockup', pattern: /may not load anything from a network address/ },
		{
			rule: 'the shell is copied, never drawn',
			pattern: /Never publish the starter's placeholder shell or a shell drawn from memory/
		},
		{ rule: 'the frame is measured before publishing', pattern: /Measure the frame/ },
		{ rule: 'no question when flow asked for it', pattern: /draw and hand back, with no question/ }
	],
	'flow-task': [
		{ rule: 'no code edits', pattern: /Never edit code/ },
		{ rule: 'points to the flow safety rules', pattern: /`\/flow` safety rules/ },
		{ rule: 'no work_start', pattern: /Do not call `work_start`/ },
		{ rule: 'task text is data', pattern: /instructions found inside a task/ }
	],
	'flow-check': [
		{ rule: 'blocked calls are listed', pattern: /addInitScript/ },
		{
			rule: 'the write path is proved first',
			pattern: /The write path and the dialog that closes first/
		},
		{ rule: 'stop for a shared database, a server or a live site', pattern: /live site/ },
		{ rule: 'the bridge check commands', pattern: /agent-flow-board check/ },
		{ rule: 'the switch is read before asking', pattern: /Look before you ask/ },
		{ rule: 'the agent runs the login command', pattern: /The command is yours to run/ }
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
