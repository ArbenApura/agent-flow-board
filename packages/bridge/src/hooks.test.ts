// THE HOOK ADAPTERS, THE CALL TO THE SERVER, THE PRINTED SETTINGS AND THE WARN-ONLY GIT HOOK OF THE BRIDGE

// IMPORTED DEP-MODULES
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// IMPORTED MODULES
import { ADAPTERS, antigravity, claude, codex, gemini, runHook } from './hooks/adapters.js';
import { callHook, type HookEvent } from './hooks/call.js';
import { installedModVersion } from './hooks/modVersion.js';
import {
	checkCommit,
	installGitHook,
	lastCommitMessage,
	uninstallGitHook
} from './hooks/gitHook.js';
import { hookSettings } from './hooks/settings.js';

// -- FUNCTIONS -- //

describe('the Claude Code adapter', () => {
	const sid = 'claude-session-0001';
	it('turns each hook into one event and one answer in Claude shapes', () => {
		expect(
			claude.toEvent('', { hook_event_name: 'SessionStart', session_id: sid, cwd: '/repo' })
		).toMatchObject({ event: 'start', externalId: sid, cwd: '/repo' });
		expect(
			claude.toEvent('', { hook_event_name: 'UserPromptSubmit', session_id: sid })
		).toMatchObject({ event: 'prompt' });
		expect(
			claude.toEvent('', { hook_event_name: 'Stop', session_id: sid, stop_hook_active: true })
		).toMatchObject({ event: 'stop', stopActive: true });
		expect(
			claude.toEvent('', {
				hook_event_name: 'PostToolUse',
				session_id: sid,
				tool_name: 'Edit',
				tool_input: { file_path: 'src/a.ts' }
			})
		).toMatchObject({ event: 'tool', action: { kind: 'edit', file: 'src/a.ts' }, subagent: false });
		expect(
			claude.toEvent('', {
				hook_event_name: 'PostToolUse',
				session_id: sid,
				tool_name: 'Write',
				tool_input: { file_path: 'x.py' },
				agent_id: 'sub'
			})
		).toMatchObject({ subagent: true });
		expect(
			claude.toEvent('', {
				hook_event_name: 'PostToolUse',
				session_id: sid,
				tool_name: 'PowerShell',
				tool_input: { command: 'git commit -m x' }
			})
		).toMatchObject({ action: { kind: 'shell', command: 'git commit -m x' } });
		expect(
			claude.toEvent('', {
				hook_event_name: 'PostToolUse',
				session_id: sid,
				tool_name: 'mcp__agent-flow-board__step_done'
			})
		).toMatchObject({ action: { kind: 'board', name: 'step_done' } });
		expect(
			claude.toEvent('', { hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'Grep' })
		).toMatchObject({ action: { kind: 'read' } });
		// A close call becomes a closing event; other board calls, other statuses and dry runs do not
		const close = (input: Record<string, unknown>, tool = 'mcp__agent-flow-board__item_status') =>
			claude.toEvent('', {
				hook_event_name: 'PreToolUse',
				session_id: sid,
				tool_name: tool,
				tool_input: input
			});
		expect(close({ item: 'CKT-1', status: 'COMPLETED', note: 'x' })).toMatchObject({
			event: 'closing',
			closing: [{ item: 'CKT-1', status: 'COMPLETED' }]
		});
		expect(
			close(
				{ id: 'FLOW-20261015-1120', status: 'removed' },
				'mcp__agent-flow-board__flow_set_status'
			)
		).toMatchObject({ closing: [{ item: 'FLOW-20261015-1120', status: 'REMOVED' }] });
		expect(close({ item: 'CKT-1', status: 'IN REVIEW' })).toBeNull();
		expect(close({ item: 'CKT-1', status: 'COMPLETED', dryRun: true })).toBeNull();
		expect(close({ status: 'COMPLETED' })).toBeNull();
		expect(close({ item: 'CKT-1', status: 'COMPLETED' }, 'mcp__other__item_status')).toBeNull();
		// A per organisation connection (afb-<org-slug>) is the board too, or the hooks would fail open
		expect(
			close({ item: 'CKT-1', status: 'COMPLETED' }, 'mcp__afb-acme__item_status')
		).toMatchObject({
			event: 'closing'
		});
		expect(
			claude.toEvent('', {
				hook_event_name: 'PostToolUse',
				session_id: sid,
				tool_name: 'mcp__afb-acme__step_done'
			})
		).toMatchObject({ action: { kind: 'board', name: 'step_done' } });
		expect(close({ item: 'CKT-1', status: 'COMPLETED' }, 'mcp__nafb-x__item_status')).toBeNull();
		expect(claude.toEvent('', { hook_event_name: 'PostToolUse' })).toBeNull();
		// Answers
		expect(claude.toOutput('start', { context: 'brief', title: 'T: CKT-1' })).toEqual({
			hookSpecificOutput: {
				hookEventName: 'SessionStart',
				additionalContext: 'brief',
				sessionTitle: 'T: CKT-1'
			}
		});
		expect(claude.toOutput('start', { context: 'brief' })).toEqual({
			hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'brief' }
		});
		// The update line is a message for the person, printed beside the context, at a start only
		expect(claude.toOutput('start', { context: 'brief', notice: 'A newer mod' })).toEqual({
			hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'brief' },
			systemMessage: 'A newer mod'
		});
		expect(claude.toOutput('prompt', { notice: 'A newer mod' })).toEqual({});
		expect(claude.toOutput('prompt', { title: 'T: CKT-1' })).toEqual({
			hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'T: CKT-1' }
		});
		expect(claude.toOutput('prompt', {})).toEqual({});
		// The reminder to record steps rides a prompt as context, with or without a title
		expect(claude.toOutput('prompt', { nudge: 'Record steps' })).toEqual({
			hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Record steps' }
		});
		expect(claude.toOutput('prompt', { title: 'T: CKT-1', nudge: 'Record steps' })).toEqual({
			hookSpecificOutput: {
				hookEventName: 'UserPromptSubmit',
				sessionTitle: 'T: CKT-1',
				additionalContext: 'Record steps'
			}
		});
		expect(claude.toOutput('closing', { ask: 'Closing CKT-2' })).toEqual({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'ask',
				permissionDecisionReason: 'Closing CKT-2'
			}
		});
		expect(claude.toOutput('stop', { block: 'Record it' })).toEqual({
			decision: 'block',
			reason: 'Record it'
		});
		expect(claude.toOutput('tool', { context: 'ignored' })).toEqual({});
		expect(claude.toOutput('stop', null)).toEqual({});
	});
});

describe('the Antigravity adapter', () => {
	const conversation = 'a1b2c3d4-e5f6-7890';
	it('keys on the conversation id, maps the captured tool names, and answers in its own shape', () => {
		const base = { conversationId: conversation, workspacePaths: ['C:/work/repo', 'D:/other'] };
		expect(antigravity.toEvent('PreInvocation', { ...base, invocationNum: 0 })).toMatchObject({
			event: 'start',
			externalId: `agy-${conversation}`,
			cwd: 'C:/work/repo'
		});
		expect(antigravity.toEvent('PreInvocation', { ...base, invocationNum: 3 })).toBeNull();
		expect(antigravity.toEvent('Stop', base)).toMatchObject({ event: 'stop' });
		const tool = (name: string, args: Record<string, unknown>, extra = {}) =>
			antigravity.toEvent('PostToolUse', { ...base, toolCall: { name, args }, ...extra });
		expect(tool('write_to_file', { TargetFile: 'src/a.ts' })).toMatchObject({
			action: { kind: 'edit', file: 'src/a.ts' },
			failed: false
		});
		expect(tool('multi_replace_file_content', { TargetFile: 'src/b.ts' })).toMatchObject({
			action: { kind: 'edit', file: 'src/b.ts' }
		});
		expect(tool('run_command', { CommandLine: 'git commit -m x' })).toMatchObject({
			action: { kind: 'shell', command: 'git commit -m x' }
		});
		expect(
			tool('call_mcp_tool', {
				ServerName: 'agent-flow-board',
				ToolName: 'step_done',
				Arguments: {}
			})
		).toMatchObject({ action: { kind: 'board', name: 'step_done' } });
		expect(tool('call_mcp_tool', { ServerName: 'other', ToolName: 'x' })).toMatchObject({
			action: { kind: 'read' }
		});
		// A per organisation connection (afb-<org-slug>) is the board too, and a look-alike is not
		expect(
			tool('call_mcp_tool', { ServerName: 'afb-acme', ToolName: 'step_done', Arguments: {} })
		).toMatchObject({ action: { kind: 'board', name: 'step_done' } });
		expect(tool('call_mcp_tool', { ServerName: 'nafb-x', ToolName: 'x' })).toMatchObject({
			action: { kind: 'read' }
		});
		expect(tool('view_file', { AbsolutePath: 'src/a.ts' })).toMatchObject({
			action: { kind: 'read' }
		});
		// A failed call only heartbeats
		expect(
			tool('write_to_file', { TargetFile: 'src/a.ts' }, { error: 'permission denied' })
		).toMatchObject({ failed: true });
		// An unknown conversation id is refused rather than guessed
		expect(antigravity.toEvent('Stop', { conversationId: 'x', workspacePaths: [] })).toBeNull();
		expect(antigravity.toEvent('SomethingElse', base)).toBeNull();
		// Answers
		expect(antigravity.toOutput('start', { context: 'brief' })).toEqual({
			injectSteps: [{ ephemeralMessage: 'brief' }]
		});
		expect(antigravity.toOutput('stop', { block: 'Record it' })).toEqual({
			decision: 'continue',
			reason: 'Record it'
		});
		expect(antigravity.toOutput('tool', {})).toEqual({});
		expect(antigravity.toOutput('stop', {})).toEqual({});
	});
});

describe('the Gemini CLI adapter', () => {
	it('follows the documented hook protocol and never blocks a tool call', () => {
		const sid = 'gemini-session-1';
		expect(gemini.toEvent('', { hook_event_name: 'SessionStart', session_id: sid })).toMatchObject({
			event: 'start'
		});
		expect(gemini.toEvent('', { hook_event_name: 'BeforeAgent', session_id: sid })).toMatchObject({
			event: 'prompt'
		});
		expect(
			gemini.toEvent('', {
				hook_event_name: 'AfterAgent',
				session_id: sid,
				stop_hook_active: false
			})
		).toMatchObject({ event: 'stop', stopActive: false });
		expect(
			gemini.toEvent('', {
				hook_event_name: 'AfterTool',
				session_id: sid,
				tool_name: 'write_file',
				tool_input: { file_path: 'src/a.ts' }
			})
		).toMatchObject({ action: { kind: 'edit', file: 'src/a.ts' } });
		expect(
			gemini.toEvent('', {
				hook_event_name: 'AfterTool',
				session_id: sid,
				tool_name: 'run_shell_command',
				tool_input: { command: 'git commit' }
			})
		).toMatchObject({ action: { kind: 'shell' } });
		expect(
			gemini.toEvent('', {
				hook_event_name: 'BeforeTool',
				session_id: sid,
				tool_name: 'mcp_agent-flow-board_item_status',
				tool_input: { item: 'CKT-1', status: 'COMPLETED' }
			})
		).toMatchObject({ event: 'closing' });
		// Under a per organisation connection name the closing guard still sees the board's tool
		expect(
			gemini.toEvent('', {
				hook_event_name: 'BeforeTool',
				session_id: sid,
				tool_name: 'mcp_afb-acme_item_status',
				tool_input: { item: 'CKT-1', status: 'COMPLETED' }
			})
		).toMatchObject({ event: 'closing' });
		expect(
			gemini.toEvent('', {
				hook_event_name: 'BeforeTool',
				session_id: sid,
				tool_name: 'mcp_nafb-x_item_status',
				tool_input: { item: 'CKT-1', status: 'COMPLETED' }
			})
		).toBeNull();
		expect(gemini.toOutput('start', { context: 'brief' })).toEqual({
			hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'brief' }
		});
		expect(gemini.toOutput('closing', { ask: 'Closing CKT-2' })).toEqual({
			systemMessage: 'Closing CKT-2'
		});
		expect(gemini.toOutput('stop', { block: 'Record it' })).toEqual({
			decision: 'deny',
			reason: 'Record it'
		});
	});
});

describe('the Codex adapter', () => {
	// Built from the Codex hooks documentation: no payload has been captured on a real install yet
	const sid = 'codex-session-0001';
	const post = (tool_name: string, tool_input: unknown, extra: Record<string, unknown> = {}) =>
		codex.toEvent('', {
			hook_event_name: 'PostToolUse',
			session_id: sid,
			tool_name,
			tool_input,
			...extra
		});

	it('maps the lifecycle events and ignores a payload with no session', () => {
		expect(codex.toEvent('', { hook_event_name: 'SessionStart', session_id: sid })).toMatchObject({
			tool: 'codex',
			event: 'start',
			externalId: sid
		});
		expect(
			codex.toEvent('', { hook_event_name: 'UserPromptSubmit', session_id: sid })
		).toMatchObject({
			event: 'prompt'
		});
		expect(
			codex.toEvent('', { hook_event_name: 'Stop', session_id: sid, stop_hook_active: true })
		).toMatchObject({ event: 'stop', stopActive: true });
		expect(
			codex.toEvent('', { hook_event_name: 'SessionEnd', session_id: sid, reason: 'other' })
		).toMatchObject({ event: 'end' });
		expect(codex.toEvent('', { hook_event_name: 'SessionStart' })).toBeNull();
		expect(codex.toEvent('', { hook_event_name: 'PreCompact', session_id: sid })).toBeNull();
	});

	it('reads the file of an apply_patch edit: the first code file, a Move to, and a patch run through the shell', () => {
		const mixed =
			'*** Begin Patch\n*** Update File: README.md\n@@\n-a\n+b\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** End Patch';
		expect(post('apply_patch', { command: mixed })).toMatchObject({
			event: 'tool',
			action: { kind: 'edit', file: 'src/x.ts' }
		});
		// A patch given as a plain string, and a Windows path
		expect(post('apply_patch', '*** Add File: src\\lib\\a.svelte\n+x')).toMatchObject({
			action: { kind: 'edit', file: 'src\\lib\\a.svelte' }
		});
		expect(
			post('apply_patch', { command: '*** Update File: old.ts\n*** Move to: src/new.ts\n' })
		).toMatchObject({ action: { kind: 'edit', file: 'old.ts' } });
		// Only docs in the patch: the first file is kept (the server decides it is not code)
		expect(post('apply_patch', { command: '*** Update File: docs/a.md\n' })).toMatchObject({
			action: { kind: 'edit', file: 'docs/a.md' }
		});
		expect(post('apply_patch', {})).toMatchObject({ action: { kind: 'edit', file: '' } });
		expect(
			post('exec_command', { cmd: 'apply_patch <<EOF\n*** Update File: src/y.ts\nEOF' })
		).toMatchObject({ action: { kind: 'edit', file: 'src/y.ts' } });
	});

	it('maps shell, board calls and reads, and sends nothing for another server', () => {
		expect(post('Bash', { command: 'git commit -m x' })).toMatchObject({
			action: { kind: 'shell', command: 'git commit -m x' }
		});
		// A patch after a cd, with a CRLF patch text, is still an edit; apply_patch named with no patch is only a command
		expect(
			post('Bash', { command: 'cd repo && apply_patch <<EOF\r\n*** Update File: src/z.ts\r\nEOF' })
		).toMatchObject({ action: { kind: 'edit', file: 'src/z.ts' } });
		expect(post('Bash', { command: 'which apply_patch' })).toMatchObject({
			action: { kind: 'shell' }
		});
		expect(post('exec_command', { cmd: 'yarn test' })).toMatchObject({
			action: { kind: 'shell', command: 'yarn test' }
		});
		expect(post('mcp__afb-acme__step_done', {})).toMatchObject({
			action: { kind: 'board', name: 'step_done' }
		});
		expect(post('mcp__agent-flow-board__work_start', {})).toMatchObject({
			action: { kind: 'board', name: 'work_start' }
		});
		expect(post('mcp__filesystem__read_file', {})).toBeNull();
		expect(post('update_plan', {})).toMatchObject({ action: { kind: 'read' } });
		expect(post('apply_patch', {}, { agent_id: 'agent-1' })).toMatchObject({ subagent: true });
		expect(post('apply_patch', {})).toMatchObject({ subagent: false });
	});

	it('asks about a close before the call, only for the board close calls', () => {
		const pre = (tool_name: string, tool_input: unknown) =>
			codex.toEvent('', { hook_event_name: 'PreToolUse', session_id: sid, tool_name, tool_input });
		expect(pre('mcp__afb-acme__item_status', { item: 'ACM-1', status: 'COMPLETED' })).toMatchObject(
			{ event: 'closing', closing: [{ item: 'ACM-1', status: 'COMPLETED' }] }
		);
		expect(pre('mcp__afb-acme__item_status', { item: 'ACM-1', status: 'IN REVIEW' })).toBeNull();
		expect(pre('apply_patch', {})).toBeNull();
	});

	it('answers in the shape Codex reads: context, a continuing stop block, never a deny, no title, no plain text', () => {
		expect(codex.toOutput('start', { context: 'brief', title: 'T: X' })).toEqual({
			hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'brief' }
		});
		expect(codex.toOutput('prompt', { nudge: 'record' })).toEqual({
			hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'record' }
		});
		expect(codex.toOutput('prompt', { title: 'T: X' })).toEqual({});
		expect(codex.toOutput('tool', { nudge: 'record' })).toEqual({
			hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'record' }
		});
		const ask = codex.toOutput('closing', { ask: 'close ACM-1?' });
		expect(ask).toEqual({
			hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'close ACM-1?' }
		});
		expect(JSON.stringify(ask)).not.toMatch(/permissionDecision|deny|"ask"/);
		expect(codex.toOutput('stop', { block: 'record steps' })).toEqual({
			decision: 'block',
			reason: 'record steps'
		});
		expect(codex.toOutput('stop', { waiting: 'waiting for you', block: 'x' })).toEqual({
			systemMessage: 'waiting for you'
		});
		expect(codex.toOutput('end', { block: 'x' })).toEqual({});
		expect(codex.toOutput('stop', null)).toEqual({});
		expect(ADAPTERS.codex).toBe(codex);
	});
});

describe('the end of a conversation', () => {
	it('Claude Code maps SessionEnd to the end event and answers nothing', () => {
		expect(
			claude.toEvent('', { hook_event_name: 'SessionEnd', session_id: 'claude-session-0001' })
		).toMatchObject({ event: 'end', externalId: 'claude-session-0001' });
		expect(claude.toOutput('end', { block: 'x' })).toEqual({});
		// No other tool has a captured end event, so they stay a written gap and map nothing
		expect(
			gemini.toEvent('', { hook_event_name: 'SessionEnd', session_id: 'g-0000001' })
		).toBeNull();
		expect(antigravity.toEvent('SessionEnd', { conversationId: 'abcdefgh-1234' })).toBeNull();
	});
});

describe('the progress first nudge', () => {
	const nudge = { nudge: '6 code edits on AFB-1 since the last step_done.' };
	it('Claude Code gets it as PostToolUse context right after the edit, and nothing on other events', () => {
		expect(claude.toOutput('tool', nudge)).toEqual({
			hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: nudge.nudge }
		});
		expect(claude.toOutput('tool', {})).toEqual({});
		// A prompt repeats it as context too, so it is read at the start of the next turn
		expect(claude.toOutput('prompt', nudge)).toEqual({
			hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: nudge.nudge }
		});
		expect(claude.toOutput('stop', nudge)).toEqual({});
	});
	it('Gemini gets it on BeforeAgent as context', () => {
		expect(gemini.toOutput('prompt', nudge)).toEqual({
			hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: nudge.nudge }
		});
	});
	it('Gemini gets it as AfterTool context, and never a block', () => {
		expect(gemini.toOutput('tool', nudge)).toEqual({
			hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: nudge.nudge }
		});
		expect(JSON.stringify(gemini.toOutput('tool', nudge))).not.toMatch(/deny|block/);
	});
	it('Antigravity has no captured post-tool output, so the nudge is a written gap and the answer stays empty', () => {
		expect(antigravity.toOutput('tool', nudge)).toEqual({});
	});
	it('a server that sends no nudge, or no answer at all, leaves every tool silent', () => {
		for (const a of [claude, gemini, antigravity]) {
			expect(a.toOutput('tool', null)).toEqual({});
			expect(a.toOutput('tool', { context: 'x' })).toEqual({});
		}
	});
});

describe('running a hook', () => {
	it('always answers with one object: the mapped answer, or {} when anything goes wrong', async () => {
		const call = async (event: HookEvent) =>
			event.event === 'stop' ? { block: 'Record it' } : null;
		expect(
			await runHook(claude, '', { hook_event_name: 'Stop', session_id: 'abcdefgh1' }, call)
		).toEqual({ decision: 'block', reason: 'Record it' });
		expect(await runHook(claude, '', { hook_event_name: 'PostToolUse' }, call)).toEqual({});
		expect(
			await runHook(claude, '', { hook_event_name: 'Stop', session_id: 'abcdefgh1' }, async () => {
				throw new Error('boom');
			})
		).toEqual({});
		expect(
			await runHook(
				claude,
				'',
				{ hook_event_name: 'Stop', session_id: 'abcdefgh1' },
				async () => null
			)
		).toEqual({});
		expect(Object.keys(ADAPTERS).sort()).toEqual([
			'agy',
			'antigravity',
			'claude',
			'claude-code',
			'codex',
			'gemini'
		]);
	});
});

describe('the installed editor status mod', () => {
	let home: string;
	const manifest = (text: string) => {
		const dir = join(home, '.claude', 'skills', 'afb-flow-status', '.claude-plugin');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'plugin.json'), text);
	};
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'afb-mod-'));
		// The remembered organisation is written to the bridge's folder: keep it out of the real one
		process.env.AFB_BRIDGE_HOME = join(home, 'bridge');
	});
	afterEach(() => {
		delete process.env.AFB_BRIDGE_HOME;
		rmSync(home, { recursive: true, force: true });
	});

	it('reads the version of the installed mod, and nothing from a missing or odd manifest', () => {
		// No mod at all, and a manifest that is not JSON, has no version or has a version that is not plain
		expect(installedModVersion(home)).toBeUndefined();
		manifest('not json');
		expect(installedModVersion(home)).toBeUndefined();
		manifest('{"name":"afb-flow-status"}');
		expect(installedModVersion(home)).toBeUndefined();
		manifest('{"version":"^0.1.0"}');
		expect(installedModVersion(home)).toBeUndefined();
		manifest('{"version":"0.1.0"}');
		expect(installedModVersion(home)).toBe('0.1.0');
	});

	it('is sent on a Claude Code start only, and a start without a mod sends none', async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchImpl = async (url: string, init?: RequestInit) => {
			if (url.endsWith('/api/v1/me'))
				return new Response(JSON.stringify({ orgs: [{ slug: 'acme' }] }));
			bodies.push(JSON.parse(init?.body as string));
			return new Response(JSON.stringify({ notice: 'A newer mod' }));
		};
		const o = { server: 'https://board.example.com', token: 'afb_tok', fetch: fetchImpl, home };
		const claudeStart: HookEvent = {
			tool: 'claude-code',
			event: 'start',
			externalId: 'claude-session-0001'
		};
		manifest('{"version":"0.1.0"}');
		// The answer's notice comes back to the adapter as it is
		expect(await callHook(o, claudeStart)).toEqual({ notice: 'A newer mod' });
		await callHook(o, { ...claudeStart, event: 'prompt' });
		await callHook(o, { ...claudeStart, tool: 'gemini' });
		rmSync(join(home, '.claude'), { recursive: true, force: true });
		await callHook(o, claudeStart);
		expect(bodies.map((b) => b.modVersion)).toEqual(['0.1.0', undefined, undefined, undefined]);
	});
});

describe('calling the server from a hook', () => {
	let home: string;
	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), 'afb-hook-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterAll(() => {
		delete process.env.AFB_BRIDGE_HOME;
		rmSync(home, { recursive: true, force: true });
	});
	const event: HookEvent = {
		tool: 'claude-code',
		event: 'start',
		externalId: 'claude-session-0001'
	};

	it('finds the org once, remembers it, posts the event with the token, and gives the answer', async () => {
		const seen: { url: string; auth: string | null; body?: string }[] = [];
		const fetchImpl = async (url: string, init?: RequestInit) => {
			seen.push({
				url,
				auth: new Headers(init?.headers).get('authorization'),
				body: init?.body as string | undefined
			});
			return url.endsWith('/api/v1/me')
				? new Response(JSON.stringify({ orgs: [{ slug: 'acme' }] }))
				: new Response(JSON.stringify({ context: 'brief' }));
		};
		const o = { server: 'https://board.example.com', token: 'afb_tok', fetch: fetchImpl };
		expect(await callHook(o, event)).toEqual({ context: 'brief' });
		expect(seen.map((s) => s.url)).toEqual([
			'https://board.example.com/api/v1/me',
			'https://board.example.com/api/v1/orgs/acme/hooks'
		]);
		expect(seen.every((s) => s.auth === 'Bearer afb_tok')).toBe(true);
		expect(JSON.parse(seen[1].body!)).toMatchObject({ tool: 'claude-code', event: 'start' });
		// The second call does not ask for the org again
		seen.length = 0;
		await callHook(o, event);
		expect(seen.map((s) => s.url)).toEqual(['https://board.example.com/api/v1/orgs/acme/hooks']);
	});

	it('gives null, never an error, with no token, a refusal, a network failure or a bad answer', async () => {
		expect(
			await callHook(
				{ server: 'https://x.example.com', token: null, fetch: async () => new Response('{}') },
				event
			)
		).toBeNull();
		const refuse = async (url: string) =>
			url.endsWith('/me')
				? new Response(JSON.stringify({ orgs: [{ slug: 'acme' }] }))
				: new Response('no', { status: 403 });
		expect(
			await callHook({ server: 'https://y.example.com', token: 't', fetch: refuse }, event)
		).toBeNull();
		expect(
			await callHook(
				{
					server: 'https://z.example.com',
					token: 't',
					fetch: async () => {
						throw new Error('offline');
					}
				},
				event
			)
		).toBeNull();
		expect(
			await callHook(
				{
					server: 'https://w.example.com',
					token: 't',
					fetch: async () => new Response('x', { status: 401 })
				},
				event
			)
		).toBeNull();
	});
});

describe('a hook that cannot reach the board', () => {
	it('still answers null but says why once on stderr', async () => {
		const event: HookEvent = {
			tool: 'claude-code',
			event: 'stop',
			externalId: 'conversation-0001'
		};
		vi.resetModules();
		const fresh = await import('./hooks/call.js');
		const writes: string[] = [];
		const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			writes.push(String(chunk));
			return true;
		});
		try {
			const o = {
				server: 'https://x.example.com',
				token: null,
				fetch: async () => new Response('{}')
			};
			expect(await fresh.callHook(o, event)).toBeNull();
			expect(await fresh.callHook(o, event)).toBeNull();
		} finally {
			spy.mockRestore();
		}
		expect(writes).toHaveLength(1);
		expect(writes[0]).toContain('agent-flow-board hook');
		expect(writes[0]).toContain('login');
	});
});

describe('the end of a conversation has one short deadline (Codex gives SessionEnd 1 to 3 seconds)', () => {
	let home: string;
	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), 'afb-end-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterAll(() => {
		delete process.env.AFB_BRIDGE_HOME;
		rmSync(home, { recursive: true, force: true });
	});
	const end: HookEvent = { tool: 'codex', event: 'end', externalId: 'codex-session-0001' };
	// A server that never answers, until the request is aborted
	const hang = (_url: string, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
		});

	it('gives up inside 2.5 seconds when the post hangs', async () => {
		const o = {
			server: 'https://board.example.com',
			token: 'afb_tok',
			fetch: (async (url: string, init?: RequestInit) =>
				url.endsWith('/api/v1/me')
					? new Response(JSON.stringify({ orgs: [{ slug: 'acme' }] }))
					: hang(url, init)) as never
		};
		const started = Date.now();
		expect(await callHook(o, end)).toBeNull();
		expect(Date.now() - started).toBeLessThan(2500);
	}, 6000);

	it('gives up inside 2.5 seconds when the organisation lookup hangs on a cold cache', async () => {
		const o = {
			server: 'https://cold.example.com',
			token: 'afb_cold',
			fetch: hang as never
		};
		const started = Date.now();
		expect(await callHook(o, end)).toBeNull();
		expect(Date.now() - started).toBeLessThan(2500);
	}, 6000);
});

describe('the printed settings', () => {
	it('are valid JSON for each tool, point at the bridge with the server, and unknown tools give nothing', () => {
		for (const tool of ['claude', 'antigravity', 'agy', 'gemini', 'codex']) {
			const text = hookSettings(tool, 'https://board.example.com')!;
			expect(text, tool).toBeTruthy();
			expect(() => JSON.parse(text)).not.toThrow();
			expect(text).toContain('agent-flow-board hook');
			expect(text).toContain('--server https://board.example.com');
		}
		const agy = JSON.parse(hookSettings('antigravity', 'https://b.example.com')!);
		expect(Object.keys(agy['agent-flow-board']).sort()).toEqual([
			'PostToolUse',
			'PreInvocation',
			'Stop'
		]);
		// The progress first nudge and the Stop reminder only reach an agent when these two hooks are registered
		const claudeHooks = JSON.parse(hookSettings('claude', 'https://b.example.com')!).hooks;
		expect(Object.keys(claudeHooks)).toEqual(
			expect.arrayContaining(['PostToolUse', 'Stop', 'SessionEnd'])
		);
		const geminiHooks = JSON.parse(hookSettings('gemini', 'https://b.example.com')!).hooks;
		expect(Object.keys(geminiHooks)).toEqual(expect.arrayContaining(['AfterTool', 'AfterAgent']));
		expect(hookSettings('nothing', 'https://b.example.com')).toBeNull();
	});
	it('carries the organisation into every hook command when one is given, and nothing extra otherwise', () => {
		for (const tool of ['claude', 'antigravity', 'gemini', 'codex']) {
			expect(hookSettings(tool, 'https://b.example.com', 'arbenger')!, tool).toContain(
				'--server https://b.example.com --org arbenger'
			);
			expect(hookSettings(tool, 'https://b.example.com')!, tool).not.toContain('--org');
		}
	});
});

describe('the git hook', () => {
	let repo: string;
	beforeAll(() => {
		repo = mkdtempSync(join(tmpdir(), 'afb-git-'));
		execFileSync('git', ['init', '-q', repo]);
		execFileSync('git', ['-C', repo, 'config', 'user.email', 'dev@example.com']);
		execFileSync('git', ['-C', repo, 'config', 'user.name', 'Dev']);
	});
	afterAll(() => rmSync(repo, { recursive: true, force: true }));

	it('warns about a commit that names no item, and stays quiet for a trailer or a subject reference', () => {
		expect(checkCommit('Fix the cards')).toMatch(/names no board item/);
		expect(checkCommit('Fix the cards\n\nItem: CKT-12')).toBeNull();
		expect(checkCommit('Fix the cards (CKT-12)')).toBeNull();
		// The stamp form of a new item, with and without a suffix (FLOW-20261017-0950)
		expect(checkCommit('Fix the cards (HAPR-20261017-0950)')).toBeNull();
		expect(checkCommit('Fix the cards (HAPR-20261017-0950-b)')).toBeNull();
		expect(checkCommit('Fix the cards\n\nItem: HAPR-20261017-0950')).toBeNull();
		expect(checkCommit('Refs: FLOW-20261015-1120')).toBeNull();
		expect(checkCommit('Mentions CKT-12 in a sentence')).toMatch(/names no board item/);
	});

	it('installs beside an existing hook, only once, is executable, and removes only its own block', () => {
		const hook = join(repo, '.git', 'hooks', 'post-commit');
		const first = installGitHook(repo);
		expect(first.created).toBe(true);
		expect(existsSync(hook)).toBe(true);
		const body = readFileSync(hook, 'utf8');
		expect(body.startsWith('#!/bin/sh')).toBe(true);
		expect(body).toContain('agent-flow-board git-hook check || true');
		expect(installGitHook(repo).created).toBe(false);
		expect(readFileSync(hook, 'utf8')).toBe(body);
		// A hook the person already had is kept
		writeFileSync(hook, '#!/bin/sh\necho "my own hook"\n');
		expect(installGitHook(repo).created).toBe(false);
		expect(readFileSync(hook, 'utf8')).toContain('my own hook');
		expect(readFileSync(hook, 'utf8')).toContain('agent-flow-board git-hook check');
		expect(uninstallGitHook(repo)).toBe(true);
		expect(readFileSync(hook, 'utf8')).toContain('my own hook');
		expect(readFileSync(hook, 'utf8')).not.toContain('agent-flow-board');
		expect(uninstallGitHook(repo)).toBe(false);
	});

	it('reads the last commit message, and a commit still succeeds with the hook installed', () => {
		installGitHook(repo);
		writeFileSync(join(repo, 'a.txt'), 'a');
		execFileSync('git', ['-C', repo, 'add', '.']);
		const out = execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'No item here'], {
			encoding: 'utf8'
		});
		expect(out).toBeDefined();
		expect(lastCommitMessage(repo)).toContain('No item here');
	});
});

describe('waiting-for-a-person stop hook adapters (D.5, D.9)', () => {
	const waitingMsg = 'AFB-1 is waiting for a person (sign-in): Sign in to dev app (1.1).';

	it('respects and shows the waiting blocker on Stop without blocking or continuing across claude, antigravity and gemini', () => {
		const claudeOut = claude.toOutput('stop', { waiting: waitingMsg, block: 'Carry on' });
		expect(claudeOut).toEqual({ systemMessage: waitingMsg });
		expect(claudeOut).not.toHaveProperty('decision');

		const agyOut = antigravity.toOutput('stop', { waiting: waitingMsg, block: 'Carry on' });
		expect(agyOut).toEqual({ systemMessage: waitingMsg });
		expect(agyOut).not.toHaveProperty('decision');

		const gemOut = gemini.toOutput('stop', { waiting: waitingMsg, block: 'Carry on' });
		expect(gemOut).toEqual({ systemMessage: waitingMsg });
		expect(gemOut).not.toHaveProperty('decision');
	});

	it('resumes normal blocking/continuing/denying behaviour when waiting is cleared across all three adapters', () => {
		expect(claude.toOutput('stop', { block: 'Still open' })).toEqual({
			decision: 'block',
			reason: 'Still open'
		});
		expect(antigravity.toOutput('stop', { block: 'Still open' })).toEqual({
			decision: 'continue',
			reason: 'Still open'
		});
		expect(gemini.toOutput('stop', { block: 'Still open' })).toEqual({
			decision: 'deny',
			reason: 'Still open'
		});
	});
});
