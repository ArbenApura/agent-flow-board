// THE HOOK ADAPTERS, THE CALL TO THE SERVER, THE PRINTED SETTINGS AND THE WARN-ONLY GIT HOOK OF THE BRIDGE

// -- DEP-MODULES -- //
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// -- MODULES -- //
import { ADAPTERS, antigravity, claude, gemini, runHook } from './hooks/adapters.js';
import { callHook, type HookEvent } from './hooks/call.js';
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
		expect(claude.toOutput('prompt', { title: 'T: CKT-1' })).toEqual({
			hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'T: CKT-1' }
		});
		expect(claude.toOutput('prompt', {})).toEqual({});
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
		expect(claude.toOutput('prompt', nudge)).toEqual({});
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
			'gemini'
		]);
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

describe('the printed settings', () => {
	it('are valid JSON for each tool, point at the bridge with the server, and unknown tools give nothing', () => {
		for (const tool of ['claude', 'antigravity', 'agy', 'gemini']) {
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
		for (const tool of ['claude', 'antigravity', 'gemini']) {
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
