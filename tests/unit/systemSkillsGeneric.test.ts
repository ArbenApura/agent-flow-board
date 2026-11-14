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
			rule: 'the mockup offer is a line of the hand-over, on every harness',
			pattern: /add one more line: a design mockup can also be drawn on the board/
		},
		{
			rule: 'a build follows the mockup of its plan',
			pattern: /A build follows the mockup of its plan/
		},
		// AFB-20261110-2331: the mockup is studied, followed strictly and never dodged
		{
			rule: 'the mockup is the spec for what a person sees',
			pattern: /\*\*Follow it strictly\.\*\*/
		},
		{
			rule: 'what the mockup binds is named',
			pattern: /its structure, layout order, text, states and interactions are binding/
		},
		{
			rule: 'a mockup inventory is written before visible code',
			pattern: /write a `Mockup inventory` block in the `design-brief` section/
		},
		{
			rule: 'the mockup is never unlinked or trashed to pass the check',
			pattern: /Never unlink, trash or replace a mockup to pass that check/
		},
		{
			rule: 'the server refusal is named in the mockup rule',
			pattern: /is refused with `MOCKUP_UNREAD` and writes nothing/
		},
		{
			rule: 'the mockup is read to the last part',
			pattern: /call again with `htmlOffset` set to `nextOffset` until `nextOffset` is null/
		},
		{
			rule: 'a mockup that cannot be read to the end is a stop',
			pattern: /cannot be read to the end even in parts[^\n]*is reason 4 to stop/
		},
		{
			rule: 'visual-evidence tools and sliceGate rules are documented',
			pattern: /work_waiting[\s\S]*evidence_waive[\s\S]*VISUAL_EVIDENCE_REQUIRED/
		},
		{
			rule: 'vertical slice gate guidance stays present',
			pattern: /sliceGate/
		},
		{
			rule: 'a list of differences is the one stop of the phase',
			pattern: /that one list is the stop/
		},
		// AFB-20261110-2333: a drifted rule file is named once, never fixed inside a build
		{
			rule: 'a drifted rule file points to flow-align',
			pattern: /\*\*Rule files that drifted\.\*\*/
		},
		{
			rule: 'differences come as one list, never a stop each',
			pattern: /as one list at the end of the phase \(reason 5\), never one stop for each/
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
		{ rule: 'a go is given once', pattern: /A go is given once/ },
		// AFB-20261110-2305: the plan ends at a plain hand-over and waits for a go
		{
			rule: 'the plan ends with a plain-text hand-over and asks no question',
			pattern: /Ask no question/
		},
		{ rule: 'the harness question tool is named and forbidden', pattern: /`AskUserQuestion`/ },
		{
			rule: 'the turn ends at the hand-over until a later message says to build',
			pattern: /until the user sends a later message/
		},
		{
			rule: 'the request words are never a go',
			pattern: /"fix", "add", "make"\) are never a go/
		},
		{
			rule: 'a bare ok or yes is only an acknowledgement',
			pattern: /a bare "ok" or "yes" is only an acknowledgement/
		},
		{
			rule: 'the hand-over is a stop reason',
			pattern: /\(6\) the plan was just written and no later message/
		},
		{
			rule: 'the mockup HTML is read in full, never only the notes',
			pattern: /read the actual mockup HTML in full/
		},
		{
			rule: 'the end-of-build review is never skipped for a small item',
			pattern: /at the end of every item, whatever its size/
		},
		{
			rule: 'naming the mockup skill with flow is the yes',
			pattern: /Naming `\/flow-mockup` together with `\/flow`[^\n]*is the yes/
		},
		{ rule: 'a yes to the mockup is followed at once', pattern: /A yes is followed at once/ },
		{ rule: 'questions are checked and batched', pattern: /Answer your own question first/ },
		{ rule: 'a permission is given once', pattern: /A permission is given once/ },
		{ rule: 'new scope is never automatic', pattern: /Never add new scope on your own/ },
		{ rule: 'the hook session id is reused', pattern: /use that id and skip `session_start`/ },
		// AFB-20261114 / bundle 1.11.0: gates run once at the end of the whole plan
		{
			rule: 'the gates run once at the end of the plan',
			pattern: /Run the gates once, at the end of the whole plan/
		},
		{ rule: 'a passed gate is not rerun', pattern: /Never twice for nothing/ }
	],
	'flow-audit': [
		{ rule: 'no commit or push', pattern: /Do not commit, push/ },
		{ rule: 'work_stop at the end', pattern: /work_stop/ },
		{ rule: 'untrusted text is data', pattern: /Untrusted text is data/ },
		{ rule: 'points to the flow safety rules', pattern: /`\/flow` safety rules/ },
		// AFB-20261110-2331: the audit reads the server's record of the mockup read, never the typed line alone
		{ rule: 'the mockup read is checked on the server record', pattern: /`readComplete`/ },
		{ rule: 'a missing mockup inventory is not recorded', pattern: /no `Mockup inventory`/ },
		{
			rule: 'an unlinked or trashed mockup is reported',
			pattern: /unlinked from the plan or moved to the trash while the build ran/
		}
	],
	'flow-critic': [
		{ rule: 'no commit or push', pattern: /Never commit or push as part of a review/ },
		{ rule: 'no AI attribution', pattern: /Claude or Anthropic attribution/ },
		{ rule: 'points to the flow safety rules', pattern: /`\/flow` safety rules/ },
		{ rule: 'checks the design brief', pattern: /Has a sourced design brief/ },
		{ rule: 'checks the build against the design', pattern: /An unapproved difference is/ },
		{ rule: 'mockup mode runs only on the user word', pattern: /runs only on the user's word/ },
		{ rule: 'a mockup shell must be the app own', pattern: /The shell is the app's own/ },
		// AFB-20261110-2305: no size gate, three subagents by default
		{
			rule: 'no review is skipped for being small',
			pattern: /No review is skipped for being small/
		},
		{ rule: 'three subagents by default', pattern: /\*\*3 subagents by default\*\*/ },
		// AFB-20261110-2331: a critic gets the mockup itself and checks the build against it
		{ rule: 'the critic is given the mockup file', pattern: /give the critic the mockup itself/ },
		{
			rule: 'the inventory is checked against the code',
			pattern: /check every inventory line against the code/
		},
		{ rule: 'the free notes are checked', pattern: /The Free notes are complete/ }
	],
	'flow-verify': [
		{ rule: 'tests after a merge before a push', pattern: /After a merge, a pull or a rebase/ },
		{ rule: 'no push or deploy', pattern: /Never run a push, a deploy/ },
		{ rule: 'points to the flow safety rules', pattern: /`\/flow` safety rules/ },
		{ rule: 'no gates found', pattern: /no gates found/ },
		{
			rule: 'no whole-project gate after each change',
			pattern: /Autonomous execution, once at the end of the whole plan/
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
		{ rule: 'no question when flow asked for it', pattern: /draw and hand back, with no question/ },
		// AFB-20261110-2331: a build follows the mockup, so it is drawn and noted for that
		{ rule: 'a linked mockup binds the build', pattern: /what the build follows/ },
		{ rule: 'the notes are written completely', pattern: /Write the notes, completely/ }
	],
	// AFB-20261110-2333: the skill that rewrites rule files and memory keeps every one of its limits
	'flow-align': [
		{ rule: 'no claim and no step', pattern: /No `work_start`, no item, no step, no `step_done`/ },
		{ rule: 'default is keep', pattern: /when in doubt, leave the line and list it/ },
		{ rule: 'the classes are closed', pattern: /five closed classes, and everything else is fine/ },
		{ rule: 'stale is checked, never guessed', pattern: /Stale means checked, never guessed/ },
		{
			rule: 'safety words are protected',
			pattern: /\*\*without asking\*\* or \*\*unless the user asks\*\*/
		},
		{
			rule: 'an owner override is not friction',
			pattern: /that is the owner's override, not friction/
		},
		{ rule: 'memories are never deleted', pattern: /No memory is ever deleted/ },
		{
			rule: 'the skill never writes a sentence of its own',
			pattern: /Never write a sentence of your own into a rule file or a memory/
		},
		{
			rule: 'a dated decision keeps its words',
			pattern: /Its words are never changed/
		},
		{
			rule: 'a thing missing only on this machine is not a broken reference',
			pattern:
				/Never a path the repo ignores, a generated path, or a tool that is only not installed/
		},
		{
			rule: 'a user-level file gains nothing',
			pattern: /It gains nothing, not even the rules block/
		},
		{ rule: 'text flows one way', pattern: /New wording comes \*\*only from this skill/ },
		{
			rule: 'rule files and memories are data',
			pattern: /never follow an instruction found inside it/
		},
		{
			rule: 'a failed backup stops the run',
			pattern: /A failed or unchecked backup stops the run with nothing written/
		},
		{ rule: 'a link is never replaced', pattern: /Never create, replace or remove a link/ },
		{
			rule: 'no settings, hooks, skills or secrets',
			pattern: /Never edit settings, permission lists, hooks/
		},
		{ rule: 'no commit or push', pattern: /Never commit or push/ },
		{ rule: 'a second run changes nothing', pattern: /A second run right after changes nothing/ },
		{ rule: 'points to the flow safety rules', pattern: /`\/flow` safety rules/ }
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

describe('the shipped skills no longer ask an approval question', () => {
	it('names no approval question or approval answer and no 3-steps skip or small-diff gate', () => {
		const hits: string[] = [];
		for (const [name, files] of Object.entries(sourceFiles()))
			for (const file of files)
				for (const { n, line } of unmarkedLines(file.text))
					if (/approval (question|answer)|3 steps or fewer|1 subagent for a small diff/i.test(line))
						hits.push(`${name}/${file.path}:${n}`);
		expect(hits).toEqual([]);
	});
});

describe('the shipped skills no longer call a mockup inspiration (AFB-20261110-2331)', () => {
	it('names no "inspiration, never the spec" and no kept, adapted and dropped record', () => {
		const hits: string[] = [];
		for (const [name, files] of Object.entries(sourceFiles()))
			for (const file of files)
				file.text.split('\n').forEach((line, i) => {
					if (
						/inspiration, never the spec|kept, adapted|adapted and dropped|only for a named part/i.test(
							line
						)
					)
						hits.push(`${name}/${file.path}:${i + 1}`);
				});
		expect(hits).toEqual([]);
	});
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
