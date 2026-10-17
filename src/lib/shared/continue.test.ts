import { describe, expect, it } from 'vitest';
import {
	CONTINUE_ACTIONS,
	LINK_LIMIT,
	TITLE_LIMIT,
	buildCommand,
	buildPrompt,
	cleanTitle,
	commandPrompt,
	effectiveMode,
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
