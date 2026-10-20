// THE THREE HOOK ADAPTERS: EACH TOOL'S OWN PAYLOAD TO ONE SMALL EVENT, AND THE SERVER'S ANSWER BACK IN THE TOOL'S OWN SHAPE (SPEC 9.3)
// Claude Code and Antigravity payloads follow what was captured on real runs. The Gemini CLI mapping follows its documented hook
// protocol and has not been captured on a real install. Every adapter prints one JSON object, `{}` when there is nothing to say.

// -- DEP-MODULES -- //
import type { HookAnswer, HookEvent } from './call.js';

// -- TYPES -- //

export type Adapter = {
	tool: HookEvent['tool'];
	/** The event, or null for a payload this adapter does not act on. */
	toEvent(name: string, payload: Record<string, unknown>): HookEvent | null;
	/** The object the tool expects on stdout. */
	toOutput(event: HookEvent['event'], answer: HookAnswer | null): Record<string, unknown>;
};

// -- CONSTANTS -- //

// The board under its older name, and under a per organisation connection name (afb-<org-slug>)
const BOARD_SERVER = /agent[-_]flow[-_]board|^(?:mcp_+)?afb-[a-z0-9]/i;

// -- FUNCTIONS -- //

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The item a close call names, when the call is a close at all. */
function closingFrom(args: Record<string, unknown>) {
	const status = text(args.status).toUpperCase();
	const item = text(args.item) || text(args.id);
	return item && (status === 'COMPLETED' || status === 'REMOVED') && args.dryRun !== true
		? [{ item, status }]
		: [];
}

// -- CLAUDE CODE -- //

export const claude: Adapter = {
	tool: 'claude-code',
	toEvent(_name, p) {
		const sessionId = text(p.session_id);
		if (!sessionId) return null;
		const base = {
			tool: 'claude-code' as const,
			externalId: sessionId,
			cwd: text(p.cwd) || undefined
		};
		const hook = text(p.hook_event_name);
		if (hook === 'SessionStart') return { ...base, event: 'start' };
		if (hook === 'UserPromptSubmit') return { ...base, event: 'prompt' };
		// The conversation ended: the server lets go of this session's claim
		if (hook === 'SessionEnd') return { ...base, event: 'end' };
		if (hook === 'Stop') return { ...base, event: 'stop', stopActive: p.stop_hook_active === true };
		const tool = text(p.tool_name);
		const input = obj(p.tool_input);
		if (hook === 'PreToolUse') {
			if (/^mcp__.*__(item_status|flow_set_status)$/.test(tool) && BOARD_SERVER.test(tool)) {
				const closing = closingFrom(input);
				return closing.length ? { ...base, event: 'closing', closing } : null;
			}
			return null;
		}
		if (hook !== 'PostToolUse') return null;
		const subagent = Boolean(p.agent_id);
		let action: HookEvent['action'] = { kind: 'read' };
		if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool))
			action = { kind: 'edit', file: text(input.file_path) || text(input.notebook_path) };
		else if (/^(Bash|PowerShell)$/.test(tool))
			action = { kind: 'shell', command: text(input.command) };
		else if (tool.startsWith('mcp__') && BOARD_SERVER.test(tool))
			action = { kind: 'board', name: tool.split('__').pop() ?? '' };
		return { ...base, event: 'tool', subagent, action };
	},
	toOutput(event, a) {
		if (!a) return {};
		if (event === 'start')
			return {
				hookSpecificOutput: {
					hookEventName: 'SessionStart',
					additionalContext: a.context ?? '',
					...(a.title ? { sessionTitle: a.title } : {})
				}
			};
		if (event === 'prompt' && a.title)
			return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: a.title } };
		// The nudge rides back from PostToolUse as context the agent reads before its next step
		if (event === 'tool' && a.nudge)
			return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: a.nudge } };
		if (event === 'closing' && a.ask)
			return {
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'ask',
					permissionDecisionReason: a.ask
				}
			};
		if (event === 'stop' && a.block) return { decision: 'block', reason: a.block };
		return {};
	}
};

// -- ANTIGRAVITY AND agy -- //

const AGY_EDIT =
	/^(write_to_file|replace_file_content|multi_replace_file_content|edit_file|create_file|delete_file)$/;

export const antigravity: Adapter = {
	tool: 'antigravity',
	toEvent(name, p) {
		const conversation = text(p.conversationId);
		if (!/^[A-Za-z0-9-]{8,64}$/.test(conversation)) return null;
		const base = {
			tool: 'antigravity' as const,
			// The prefix keeps a conversation id apart from the ids other tools use
			externalId: `agy-${conversation}`,
			cwd: (Array.isArray(p.workspacePaths) ? text(p.workspacePaths[0]) : '') || undefined
		};
		if (name === 'PreInvocation')
			return Number(p.invocationNum ?? 0) === 0 ? { ...base, event: 'start' } : null;
		if (name === 'Stop') return { ...base, event: 'stop' };
		if (name !== 'PostToolUse') return null;
		const call = obj(p.toolCall);
		const args = obj(call.args);
		const failed = text(p.error).trim() !== '';
		const tool = text(call.name);
		let action: HookEvent['action'] = { kind: 'read' };
		if (AGY_EDIT.test(tool) || typeof args.TargetFile === 'string')
			action = { kind: 'edit', file: text(args.TargetFile) || text(args.AbsolutePath) };
		else if (tool === 'run_command') action = { kind: 'shell', command: text(args.CommandLine) };
		else if (tool === 'call_mcp_tool' && BOARD_SERVER.test(text(args.ServerName)))
			action = { kind: 'board', name: text(args.ToolName) };
		return { ...base, event: 'tool', failed, action };
	},
	toOutput(event, a) {
		if (!a) return {};
		// Antigravity has no hook output that names a conversation, so the board label carries the title instead
		if (event === 'start' && a.context) return { injectSteps: [{ ephemeralMessage: a.context }] };
		// GAP: no PostToolUse output was captured for Antigravity, so the nudge is not sent here. Its sessions still hear the
		// progress line in every board reply and the Stop reminder, which name the steps that are not recorded.
		// A Stop "continue" re-enters the agent loop. The server sends at most one per distinct code change.
		if (event === 'stop' && a.block) return { decision: 'continue', reason: a.block };
		return {};
	}
};

// -- GEMINI CLI -- //

export const gemini: Adapter = {
	tool: 'gemini',
	toEvent(_name, p) {
		const sessionId = text(p.session_id);
		if (!sessionId) return null;
		const base = { tool: 'gemini' as const, externalId: sessionId, cwd: text(p.cwd) || undefined };
		const hook = text(p.hook_event_name);
		if (hook === 'SessionStart') return { ...base, event: 'start' };
		if (hook === 'BeforeAgent') return { ...base, event: 'prompt' };
		if (hook === 'AfterAgent')
			return { ...base, event: 'stop', stopActive: p.stop_hook_active === true };
		const tool = text(p.tool_name);
		const input = obj(p.tool_input);
		if (hook === 'BeforeTool') {
			if (/^mcp_.*(item_status|flow_set_status)$/.test(tool) && BOARD_SERVER.test(tool)) {
				const closing = closingFrom(input);
				return closing.length ? { ...base, event: 'closing', closing } : null;
			}
			return null;
		}
		if (hook !== 'AfterTool') return null;
		let action: HookEvent['action'] = { kind: 'read' };
		if (/^(write_file|replace|edit)$/.test(tool))
			action = { kind: 'edit', file: text(input.file_path) || text(input.path) };
		else if (tool === 'run_shell_command') action = { kind: 'shell', command: text(input.command) };
		else if (tool.startsWith('mcp_') && BOARD_SERVER.test(tool))
			action = { kind: 'board', name: tool.split('_').pop() ?? '' };
		return { ...base, event: 'tool', action };
	},
	toOutput(event, a) {
		if (!a) return {};
		if (event === 'start')
			return {
				hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: a.context ?? '' }
			};
		// Not captured on a real install: AfterTool takes additionalContext in the documented protocol
		if (event === 'tool' && a.nudge)
			return { hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: a.nudge } };
		// Gemini cannot ask before a tool call, so the close question is a message, never a block
		if (event === 'closing' && a.ask) return { systemMessage: a.ask };
		if (event === 'stop' && a.block) return { decision: 'deny', reason: a.block };
		return {};
	}
};

export const ADAPTERS: Record<string, Adapter> = {
	claude,
	'claude-code': claude,
	antigravity,
	agy: antigravity,
	gemini
};

/** Runs one hook: payload in, one JSON object out. Never throws, never blocks. */
export async function runHook(
	adapter: Adapter,
	name: string,
	payload: Record<string, unknown>,
	call: (event: HookEvent) => Promise<HookAnswer | null>
): Promise<Record<string, unknown>> {
	try {
		const event = adapter.toEvent(name, payload);
		if (!event) return {};
		return adapter.toOutput(event.event, await call(event));
	} catch {
		return {};
	}
}
