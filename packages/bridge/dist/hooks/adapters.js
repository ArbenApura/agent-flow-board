// THE HOOK ADAPTERS: EACH TOOL'S OWN PAYLOAD TO ONE SMALL EVENT, AND THE SERVER'S ANSWER BACK IN THE TOOL'S OWN SHAPE (SPEC 9.3)
// Claude Code and Antigravity payloads follow what was captured on real runs. The Gemini CLI and Codex mappings follow their documented
// hook protocols and have not been captured on a real install. Every adapter prints one JSON object, `{}` when there is nothing to say.
// -- CONSTANTS -- //
// The board under its older name, and under a per organisation connection name (afb-<org-slug>)
const BOARD_SERVER = /agent[-_]flow[-_]board|^(?:mcp_+)?afb-[a-z0-9]/i;
// -- FUNCTIONS -- //
const text = (v) => (typeof v === 'string' ? v : '');
const obj = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
/** The item a close call names, when the call is a close at all. */
function closingFrom(args) {
    const status = text(args.status).toUpperCase();
    const item = text(args.item) || text(args.id);
    return item && (status === 'COMPLETED' || status === 'REMOVED') && args.dryRun !== true
        ? [{ item, status }]
        : [];
}
// -- CLAUDE CODE -- //
export const claude = {
    tool: 'claude-code',
    toEvent(_name, p) {
        const sessionId = text(p.session_id);
        if (!sessionId)
            return null;
        const base = {
            tool: 'claude-code',
            externalId: sessionId,
            cwd: text(p.cwd) || undefined
        };
        const hook = text(p.hook_event_name);
        // The editor mod reads the status file, so the events that can change what a conversation works on ask for the status:
        // the start, each prompt, the stop, and a call of the board's own tools (a claim, a step, a release). Plain edits and reads do not.
        if (hook === 'SessionStart')
            return { ...base, event: 'start', status: true };
        if (hook === 'UserPromptSubmit')
            return { ...base, event: 'prompt', status: true };
        // The conversation ended: the server lets go of this session's claim
        if (hook === 'SessionEnd')
            return { ...base, event: 'end' };
        if (hook === 'Stop')
            return { ...base, event: 'stop', stopActive: p.stop_hook_active === true, status: true };
        const tool = text(p.tool_name);
        const input = obj(p.tool_input);
        if (hook === 'PreToolUse') {
            if (/^mcp__.*__(item_status|flow_set_status)$/.test(tool) && BOARD_SERVER.test(tool)) {
                const closing = closingFrom(input);
                return closing.length ? { ...base, event: 'closing', closing } : null;
            }
            return null;
        }
        if (hook !== 'PostToolUse')
            return null;
        const subagent = Boolean(p.agent_id);
        let action = { kind: 'read' };
        if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool))
            action = { kind: 'edit', file: text(input.file_path) || text(input.notebook_path) };
        else if (/^(Bash|PowerShell)$/.test(tool))
            action = { kind: 'shell', command: text(input.command) };
        else if (tool.startsWith('mcp__') && BOARD_SERVER.test(tool))
            action = { kind: 'board', name: tool.split('__').pop() ?? '' };
        return {
            ...base,
            event: 'tool',
            subagent,
            action,
            ...(action.kind === 'board' ? { status: true } : {})
        };
    },
    toOutput(event, a) {
        if (!a)
            return {};
        if (event === 'start')
            return {
                hookSpecificOutput: {
                    hookEventName: 'SessionStart',
                    additionalContext: a.context ?? '',
                    ...(a.title ? { sessionTitle: a.title } : {})
                },
                // The one line for the person (an older editor status mod), shown once as the conversation starts
                ...(a.notice ? { systemMessage: a.notice } : {})
            };
        if (event === 'prompt' && (a.title || a.nudge))
            return {
                hookSpecificOutput: {
                    hookEventName: 'UserPromptSubmit',
                    ...(a.title ? { sessionTitle: a.title } : {}),
                    // The reminder to record unrecorded steps, read by the agent with the person's prompt
                    ...(a.nudge ? { additionalContext: a.nudge } : {})
                }
            };
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
        if (event === 'stop' && a.waiting)
            return { systemMessage: a.waiting };
        if (event === 'stop' && a.block)
            return { decision: 'block', reason: a.block };
        return {};
    }
};
// -- ANTIGRAVITY AND agy -- //
const AGY_EDIT = /^(write_to_file|replace_file_content|multi_replace_file_content|edit_file|create_file|delete_file)$/;
export const antigravity = {
    tool: 'antigravity',
    toEvent(name, p) {
        const conversation = text(p.conversationId);
        if (!/^[A-Za-z0-9-]{8,64}$/.test(conversation))
            return null;
        const base = {
            tool: 'antigravity',
            // The prefix keeps a conversation id apart from the ids other tools use
            externalId: `agy-${conversation}`,
            cwd: (Array.isArray(p.workspacePaths) ? text(p.workspacePaths[0]) : '') || undefined
        };
        if (name === 'PreInvocation')
            return Number(p.invocationNum ?? 0) === 0 ? { ...base, event: 'start' } : null;
        if (name === 'Stop')
            return { ...base, event: 'stop' };
        if (name !== 'PostToolUse')
            return null;
        const call = obj(p.toolCall);
        const args = obj(call.args);
        const failed = text(p.error).trim() !== '';
        const tool = text(call.name);
        let action = { kind: 'read' };
        if (AGY_EDIT.test(tool) || typeof args.TargetFile === 'string')
            action = { kind: 'edit', file: text(args.TargetFile) || text(args.AbsolutePath) };
        else if (tool === 'run_command')
            action = { kind: 'shell', command: text(args.CommandLine) };
        else if (tool === 'call_mcp_tool' && BOARD_SERVER.test(text(args.ServerName)))
            action = { kind: 'board', name: text(args.ToolName) };
        return { ...base, event: 'tool', failed, action };
    },
    toOutput(event, a) {
        if (!a)
            return {};
        // Antigravity has no hook output that names a conversation, so the board label carries the title instead
        if (event === 'start' && a.context)
            return { injectSteps: [{ ephemeralMessage: a.context }] };
        // GAP: no PostToolUse output was captured for Antigravity, so the nudge is not sent here. Its sessions still hear the
        // progress line in every board reply and the Stop reminder, which name the steps that are not recorded.
        // A Stop "continue" re-enters the agent loop. The server sends at most one per distinct code change.
        // When waiting for a person, never re-enter the loop: show the blocker message instead.
        if (event === 'stop' && a.waiting)
            return { systemMessage: a.waiting };
        if (event === 'stop' && a.block)
            return { decision: 'continue', reason: a.block };
        return {};
    }
};
// -- GEMINI CLI -- //
export const gemini = {
    tool: 'gemini',
    toEvent(_name, p) {
        const sessionId = text(p.session_id);
        if (!sessionId)
            return null;
        const base = { tool: 'gemini', externalId: sessionId, cwd: text(p.cwd) || undefined };
        const hook = text(p.hook_event_name);
        if (hook === 'SessionStart')
            return { ...base, event: 'start' };
        if (hook === 'BeforeAgent')
            return { ...base, event: 'prompt' };
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
        if (hook !== 'AfterTool')
            return null;
        let action = { kind: 'read' };
        if (/^(write_file|replace|edit)$/.test(tool))
            action = { kind: 'edit', file: text(input.file_path) || text(input.path) };
        else if (tool === 'run_shell_command')
            action = { kind: 'shell', command: text(input.command) };
        else if (tool.startsWith('mcp_') && BOARD_SERVER.test(tool))
            action = { kind: 'board', name: tool.split('_').pop() ?? '' };
        return { ...base, event: 'tool', action };
    },
    toOutput(event, a) {
        if (!a)
            return {};
        if (event === 'start')
            return {
                hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: a.context ?? '' }
            };
        // Not captured on a real install: BeforeAgent takes additionalContext in the documented protocol
        if (event === 'prompt' && a.nudge)
            return { hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: a.nudge } };
        // Not captured on a real install: AfterTool takes additionalContext in the documented protocol
        if (event === 'tool' && a.nudge)
            return { hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: a.nudge } };
        // Gemini cannot ask before a tool call, so the close question is a message, never a block
        if (event === 'closing' && a.ask)
            return { systemMessage: a.ask };
        if (event === 'stop' && a.waiting)
            return { systemMessage: a.waiting };
        if (event === 'stop' && a.block)
            return { decision: 'deny', reason: a.block };
        return {};
    }
};
// -- CODEX -- //
// Source of the next four constants: the Codex hooks documentation. NOT CAPTURED on a real install yet (the first real session after
// the person has reviewed the hooks is compared with this adapter, AFB-20261115-1503).
const PATCH_PATH = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+?)\s*$/gm;
const CODEX_CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|svelte|vue|astro|py|rb|go|rs|java|kt|cs|php|swift|c|h|cc|cpp|hpp|css|scss|less|html|sql|sh|ps1|bat|lua|dart|ex|exs)$/i;
const CODEX_NOT_CODE_DIR = /(?:^|\/)(?:\.git|\.board|\.claude|\.agents|\.gemini|\.vscode|\.idea|node_modules|dist|build|\.svelte-kit|coverage|docs?|\.afb)(?:\/|$)/i;
const CODEX_SHELL = /^(Bash|exec_command|shell|local_shell)$/;
/** The patch text of an apply_patch call: the tool input as a string, or the first of its likely keys. */
function patchText(input) {
    if (typeof input === 'string')
        return input;
    const o = obj(input);
    return text(o.command) || text(o.patch) || text(o.input) || text(o.cmd);
}
/**
 * The file an apply_patch edit is for. A patch can name several files; the server counts an edit only when the file is code, so the
 * first code file wins, else the first file, else empty.
 */
function patchFile(patch) {
    const files = [...patch.matchAll(PATCH_PATH)].map((m) => m[1]);
    const code = files.find((f) => {
        const p = f.replace(/\\/g, '/');
        return CODEX_CODE_EXT.test(p) && !CODEX_NOT_CODE_DIR.test(p);
    });
    return code ?? files[0] ?? '';
}
export const codex = {
    tool: 'codex',
    toEvent(_name, p) {
        const sessionId = text(p.session_id);
        if (!sessionId)
            return null;
        const base = { tool: 'codex', externalId: sessionId, cwd: text(p.cwd) || undefined };
        const hook = text(p.hook_event_name);
        if (hook === 'SessionStart')
            return { ...base, event: 'start' };
        if (hook === 'UserPromptSubmit')
            return { ...base, event: 'prompt' };
        // The conversation ended: the server lets go of this session's claim (Codex gives this hook 1 to 3 seconds)
        if (hook === 'SessionEnd')
            return { ...base, event: 'end' };
        if (hook === 'Stop')
            return { ...base, event: 'stop', stopActive: p.stop_hook_active === true };
        const tool = text(p.tool_name);
        const input = obj(p.tool_input);
        if (hook === 'PreToolUse') {
            if (/^mcp__.*__(item_status|flow_set_status)$/.test(tool) && BOARD_SERVER.test(tool)) {
                const closing = closingFrom(input);
                return closing.length ? { ...base, event: 'closing', closing } : null;
            }
            return null;
        }
        if (hook !== 'PostToolUse')
            return null;
        let action = { kind: 'read' };
        if (tool === 'apply_patch' || /^(Edit|Write)$/.test(tool))
            action = { kind: 'edit', file: patchFile(patchText(p.tool_input)) };
        else if (CODEX_SHELL.test(tool)) {
            const command = text(input.command) || text(input.cmd);
            // A patch applied through the shell is an edit too, also after a `cd repo &&`
            action =
                /(?:^|[;&|]\s*|\s)apply_patch\b/.test(command) &&
                    /^\*\*\* (?:Update|Add|Delete) File: /m.test(command)
                    ? { kind: 'edit', file: patchFile(command) }
                    : { kind: 'shell', command: command.slice(0, 4000) };
        }
        else if (tool.startsWith('mcp__')) {
            // Another server's tool says nothing about the plan record, so it costs no round trip
            if (!BOARD_SERVER.test(tool))
                return null;
            action = { kind: 'board', name: tool.split('__').pop() ?? '' };
        }
        return { ...base, event: 'tool', subagent: Boolean(p.agent_id), action };
    },
    toOutput(event, a) {
        if (!a)
            return {};
        // Only JSON ever reaches Codex: plain stdout text becomes context on a start or a prompt and is invalid on a stop
        if (event === 'start')
            return {
                hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: a.context ?? '' }
            };
        if (event === 'prompt' && a.nudge)
            return {
                hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: a.nudge }
            };
        if (event === 'tool' && a.nudge)
            return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: a.nudge } };
        // Codex cannot ask before a tool call (ask is unsupported), so the close question reaches the agent as context and never denies
        if (event === 'closing' && a.ask)
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: a.ask } };
        if (event === 'stop' && a.waiting)
            return { systemMessage: a.waiting };
        // A Stop block continues the turn; the reason becomes the next prompt. The server sends at most one per distinct code change.
        if (event === 'stop' && a.block)
            return { decision: 'block', reason: a.block };
        return {};
    }
};
export const ADAPTERS = {
    claude,
    'claude-code': claude,
    antigravity,
    agy: antigravity,
    gemini,
    codex
};
/** Runs one hook: payload in, one JSON object out. Never throws, never blocks. */
export async function runHook(adapter, name, payload, call) {
    try {
        const event = adapter.toEvent(name, payload);
        if (!event)
            return {};
        return adapter.toOutput(event.event, await call(event));
    }
    catch {
        return {};
    }
}
