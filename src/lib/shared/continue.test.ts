import { describe, expect, it } from 'vitest';
import {
	CONTINUE_ACTIONS,
	IDEA_LIMIT,
	LINK_LIMIT,
	TITLE_LIMIT,
	buildCommand,
	buildCreatePrompt,
	buildPrompt,
	cleanIdea,
	cleanTitle,
	commandPrompt,
	effectiveMode,
	isProjectKey,
	isRef,
	isSafeCommandText,
	parseMode,
	parseTool,
	slashCommand,
	usesSlash,
	validPair,
	vscodeLink,
	type ContinueAction,
	type ContinueToolId
} from './continue';

const ATTACKS = [
	'x $(Start-Process calc)',
	'x `calc`',
	'x"; calc; "',
	'echo %PATH%',
	'run !!',
	'one\ntwo',
	'one\r\ntwo',
	"it's",
	'a & b | c',
	'a ^ b',
	'$env:USERPROFILE',
	'back\\slash'
];
const URL = 'http://localhost:5180/m/HAPR/HAPR-2';
const prompt = (action: ContinueAction, tool: ContinueToolId, title = 'Partial refunds') =>
	buildPrompt({ action, tool, ref: 'HAPR-2', title, url: URL });

describe('Claude Code runs the workflow as a slash command', () => {
	it('uses the /flow skills in the same shape as the HAPR Board', () => {
		expect(prompt('resume', 'claude-code')).toBe('/flow resume HAPR-2');
		expect(prompt('audit', 'claude-code')).toBe('/flow-audit HAPR-2');
		expect(prompt('critic', 'claude-code')).toBe('/flow-critic HAPR-2');
		expect(prompt('interview', 'claude-code')).toBe('/flow-interview HAPR-2');
		expect(prompt('ask', 'claude-code')).toBe('/flow HAPR-2: ');
	});

	it('carries no title and no address, so it is safe in a command', () => {
		const text = prompt('resume', 'claude-code');
		expect(text).not.toContain('Partial');
		expect(text).not.toContain('http');
		expect(isSafeCommandText(text)).toBe(true);
	});

	it('writes the stamp form of a new item, with or without a suffix', () => {
		expect(slashCommand('resume', 'HAPR-20261017-0950')).toBe('/flow resume HAPR-20261017-0950');
		expect(slashCommand('audit', 'HAPR-20261017-0950-b')).toBe('/flow-audit HAPR-20261017-0950-b');
		expect(slashCommand('ask', 'HAPR-20261017-0950')).toBe('/flow HAPR-20261017-0950: ');
		const text = commandPrompt('resume', 'claude-code', 'HAPR-20261017-0950-b') as string;
		expect(isSafeCommandText(text)).toBe(true);
		expect(buildCommand('claude-code', text)).toBe('claude "/flow resume HAPR-20261017-0950-b"');
	});

	it('refuses a stamp that is not exactly one the app writes', () => {
		for (const bad of [
			'HAPR-20261017-0950-B',
			'HAPR-20261017-0950-bb',
			'HAPR-2026101-0950',
			'HAPR-20261017-0950"; calc',
			'HAPR-20261017-0950\n',
			'hapr-20261017-0950'
		])
			expect(slashCommand('resume', bad), bad).toBeNull();
	});

	it('refuses a reference the app would not write', () => {
		for (const bad of ['hapr-2', 'HAPR-', 'HAPR-2 x', 'HAPR-2"; calc', 'HAPR-2\n', '$(x)-1', ''])
			expect(slashCommand('resume', bad), bad).toBeNull();
	});

	it('is used for every action of Claude Code, and for no other tool', () => {
		for (const action of CONTINUE_ACTIONS) {
			expect(usesSlash('claude-code', action), action).toBe(true);
			expect(usesSlash('codex', action), action).toBe(false);
		}
	});
});

describe('plain words for a tool without MCP prompts', () => {
	it('names the workflow, the connection and the tools for every action', () => {
		const flows: Record<ContinueAction, string> = {
			resume: 'workflow_get flow',
			ask: 'workflow_get flow',
			audit: 'workflow_get flow-audit',
			critic: 'workflow_get flow-critic',
			interview: 'workflow_get flow-interview'
		};
		for (const action of CONTINUE_ACTIONS) {
			const p = prompt(action, 'codex');
			expect(p, action).toContain('agent-flow-board');
			expect(p, action).toContain('HAPR-2');
			expect(p, action).toContain(flows[action]);
		}
		expect(prompt('resume', 'codex')).toContain('session_start');
		expect(prompt('resume', 'codex')).toContain('step_done');
	});

	it('adds the title and the address to the copied prompt', () => {
		const p = prompt('resume', 'codex');
		expect(p).toContain('Item: Partial refunds.');
		expect(p).toContain(`Address: ${URL}`);
	});

	it('leaves Ask open for the person to finish after the colon', () => {
		expect(prompt('ask', 'claude-code')).toBe('/flow HAPR-2: ');
		const plain = prompt('ask', 'codex');
		expect(plain.endsWith(': ')).toBe(true);
		expect(plain).toContain('workflow_get flow');
	});
});

describe('the title', () => {
	it('has control characters and line breaks removed', () => {
		const separator = String.fromCharCode(0x2028);
		const p = prompt('resume', 'codex', `a\nb\r\nc\u0000d${separator}e`);
		expect(p).toContain('Item: a b c d e.');
		const bad = [...p].filter((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x2028);
		expect(bad).toEqual([]);
	});

	it('is cut with an ellipsis', () => {
		const t = cleanTitle('x'.repeat(500));
		expect(t.length).toBe(TITLE_LIMIT);
		expect(t.endsWith('…')).toBe(true);
	});

	it('never reaches a command', () => {
		for (const action of CONTINUE_ACTIONS)
			for (const tool of ['claude-code', 'codex', 'gemini'] as const) {
				const text = commandPrompt(action, tool, 'HAPR-2') as string;
				expect(text, `${action} ${tool}`).not.toContain('Partial');
				expect(text, `${action} ${tool}`).not.toContain('http');
				expect(buildCommand(tool, text.trim()), `${action} ${tool}`).not.toBeNull();
			}
	});
});

describe('buildCommand', () => {
	it('starts the tool with the workflow', () => {
		const text = commandPrompt('resume', 'claude-code', 'HAPR-2') as string;
		expect(buildCommand('claude-code', text)).toBe('claude "/flow resume HAPR-2"');
	});

	it('uses the right program for each tool', () => {
		const text = commandPrompt('resume', 'codex', 'HAPR-2') as string;
		expect(buildCommand('codex', text)).toMatch(/^codex "Continue HAPR-2 in agent-flow-board/);
		expect(buildCommand('gemini', text)).toMatch(/^gemini -i "/);
		expect(buildCommand('other', text)).toBeNull();
	});

	it('refuses any text with a character a shell treats as special', () => {
		for (const evil of ATTACKS) {
			expect(isSafeCommandText(evil), evil).toBe(false);
			expect(buildCommand('claude-code', evil), evil).toBeNull();
		}
		expect(buildCommand('claude-code', '')).toBeNull();
	});

	it('refuses a text that starts with a dash, which a tool would read as a flag', () => {
		expect(buildCommand('claude-code', '--dangerously-skip')).toBeNull();
		expect(buildCommand('claude-code', ' -p run')).toBeNull();
	});

	it('accepts a plain sentence', () => {
		expect(buildCommand('claude-code', 'Continue HAPR-2, read the plan.')).toBe(
			'claude "Continue HAPR-2, read the plan."'
		);
	});
});

describe('the New plan and New task prompts', () => {
	const make = (kind: 'plan' | 'task', tool: ContinueToolId, idea: string, key = 'AFB') =>
		buildCreatePrompt({ kind, tool, key, idea });

	it('are slash commands for Claude Code with the project key', () => {
		expect(make('plan', 'claude-code', 'add dark mode')).toBe('/flow new AFB: add dark mode');
		expect(make('task', 'claude-code', 'fix the typo')).toBe('/flow-task AFB: fix the typo');
	});

	it('are plain words that name the workflow for every other tool', () => {
		for (const tool of ['codex', 'gemini', 'other'] as const) {
			const plan = make('plan', tool, 'add dark mode');
			expect(plan, tool).toContain('workflow_get flow,');
			expect(plan, tool).toContain('project AFB');
			expect(plan, tool).toContain('session_start');
			expect(plan.endsWith('add dark mode'), tool).toBe(true);
			const task = make('task', tool, 'fix the typo');
			expect(task, tool).toContain('workflow_get flow-task');
			expect(task, tool).toContain('project AFB');
			expect(task.endsWith('fix the typo'), tool).toBe(true);
		}
	});

	it('stay open when the idea is empty, so the dialog can ask for it', () => {
		expect(make('plan', 'claude-code', '  ')).toBe('/flow new AFB: ');
		expect(make('task', 'claude-code', '')).toBe('/flow-task AFB: ');
		expect(make('task', 'codex', '').endsWith(': ')).toBe(true);
	});

	it('become a command only when every character of the idea is plain text', () => {
		const plain = make('task', 'claude-code', 'fix the typo on the pricing page');
		expect(buildCommand('claude-code', plain)).toBe(
			'claude "/flow-task AFB: fix the typo on the pricing page"'
		);
		for (const evil of ATTACKS) {
			const text = make('task', 'claude-code', evil);
			expect(buildCommand('claude-code', text), evil).toBeNull();
			// The prompt and the VS Code link still work for the same text
			expect(text, evil).toContain('/flow-task AFB: ');
			expect(vscodeLink(text), evil).not.toBeNull();
		}
		expect(buildCommand('codex', make('plan', 'codex', 'add dark mode'))).toMatch(
			/^codex "Use the/
		);
	});

	it('keep the line breaks of a pasted list and drop other control characters', () => {
		const text = make('task', 'claude-code', 'one\r\ntwo \u0000 three\n\n  four');
		expect(text).toBe('/flow-task AFB: one\ntwo three\n\nfour');
		expect(cleanIdea('a\u0007b')).toBe('a b');
	});

	it('cut a very long idea, which the link then refuses and the prompt still carries', () => {
		const idea = 'x'.repeat(IDEA_LIMIT * 3);
		expect(cleanIdea(idea).length).toBe(IDEA_LIMIT);
		const text = make('task', 'claude-code', idea + 'é'.repeat(3000));
		expect(text.length).toBeLessThan(IDEA_LIMIT + 40);
		expect(vscodeLink(make('task', 'claude-code', '%'.repeat(IDEA_LIMIT)))).toBeNull();
	});

	it('refuse a project key the app would not write', () => {
		for (const bad of ['', 'a', 'afb', 'A', 'AFB-1', 'AFB"; calc', 'ABCDEFGHIJK', 'AFB\n'])
			expect(make('plan', 'claude-code', 'x', bad), bad).toBe('');
		expect(isProjectKey('AFB')).toBe(true);
		expect(isProjectKey('HAPR2')).toBe(true);
	});
});

describe('isRef', () => {
	it('only accepts a reference the app writes', () => {
		expect(isRef('HAPR-2')).toBe(true);
		expect(isRef('CKT-1234')).toBe(true);
		for (const bad of ['hapr-2', 'HAPR-', 'HAPR-2 x', 'HAPR-2"; calc', 'HAPR-2\n', '$(x)-1', '']) {
			expect(isRef(bad), bad).toBe(false);
			expect(commandPrompt('resume', 'codex', bad), bad).toBeNull();
		}
	});
});

describe('vscodeLink', () => {
	it('encodes the prompt', () => {
		const link = vscodeLink('Continue HAPR-2 "x" & y');
		expect(link).toBe(
			'vscode://anthropic.claude-code/open?prompt=Continue%20HAPR-2%20%22x%22%20%26%20y'
		);
	});

	it('gives nothing for a link that is too long', () => {
		expect(vscodeLink('a'.repeat(LINK_LIMIT))).toBeNull();
		expect(vscodeLink('a'.repeat(100))).not.toBeNull();
	});
});

describe('tool and way rules', () => {
	it('falls back to the defaults for an unknown value', () => {
		expect(parseTool('nope')).toBe('claude-code');
		expect(parseTool(undefined)).toBe('claude-code');
		// A tool that is no longer offered reads as the default, so no list shows a blank choice
		expect(parseTool('codex')).toBe('claude-code');
		expect(parseTool('gemini')).toBe('claude-code');
		expect(parseTool('other')).toBe('other');
		expect(parseMode('nope')).toBe('vscode');
		expect(parseMode('prompt')).toBe('prompt');
	});

	it('allows Open in VS Code only with Claude Code', () => {
		expect(validPair('claude-code', 'vscode')).toBe(true);
		expect(validPair('codex', 'vscode')).toBe(false);
		expect(validPair('codex', 'command')).toBe(true);
		expect(validPair('other', 'prompt')).toBe(true);
	});

	it('falls back to a way the tool can do', () => {
		expect(effectiveMode('codex', 'vscode')).toBe('command');
		expect(effectiveMode('other', 'vscode')).toBe('prompt');
		expect(effectiveMode('other', 'command')).toBe('prompt');
		expect(effectiveMode('claude-code', 'vscode')).toBe('vscode');
	});
});
