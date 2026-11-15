// THE HOOK SETTINGS EACH TOOL NEEDS, PRINTED FOR THE PERSON TO PASTE. THE BRIDGE NEVER EDITS A TOOL'S SETTINGS BY ITSELF.
// Hook commands carry no quotes around their paths, so they work where a shell strips them (cmd /c on Windows).
// -- CONSTANTS -- //
/** Host, port and path characters only, so the address cannot carry a space, a quote or a shell operator into a hook command. */
const SERVER_SHAPE = /^https?:\/\/[A-Za-z0-9.\-:[\]]+(\/[A-Za-z0-9._~\-/]*)?$/;
// -- FUNCTIONS -- //
/** The server address as a hook command may carry it, or null when it is not a plain http(s) address (no userinfo, no odd characters). */
export function validServer(server) {
    const s = server.replace(/\/$/, '');
    if (!SERVER_SHAPE.test(s))
        return null;
    try {
        const u = new URL(s);
        return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password
            ? s
            : null;
    }
    catch {
        return null;
    }
}
/** The settings block for one tool, or null for a name that is not known. */
export function hookSettings(tool, server, org) {
    // With an organisation the hook reads that organisation's sign in
    const bin = (adapter, event = '') => `agent-flow-board hook ${adapter}${event ? ` ${event}` : ''} --server ${server}${org ? ` --org ${org}` : ''}`;
    if (tool === 'claude' || tool === 'claude-code') {
        const command = (timeout) => [{ type: 'command', command: bin('claude'), timeout }];
        return JSON.stringify({
            hooks: {
                SessionStart: [{ hooks: command(15) }],
                UserPromptSubmit: [{ hooks: command(10) }],
                PreToolUse: [{ matcher: '^mcp__.*__(item_status|flow_set_status)$', hooks: command(10) }],
                PostToolUse: [{ matcher: '.*', hooks: command(10) }],
                Stop: [{ hooks: command(20) }],
                // The conversation ended: the server lets go of this session's claim
                SessionEnd: [{ hooks: command(10) }]
            }
        }, null, 2);
    }
    if (tool === 'antigravity' || tool === 'agy') {
        const at = (event, timeout) => ({
            type: 'command',
            command: bin('antigravity', event),
            timeout
        });
        return JSON.stringify({
            'agent-flow-board': {
                PostToolUse: [{ matcher: '*', hooks: [at('PostToolUse', 15)] }],
                PreInvocation: [at('PreInvocation', 25)],
                Stop: [at('Stop', 25)]
            }
        }, null, 2);
    }
    if (tool === 'codex') {
        // The same shape as Claude Code's (~/.codex/hooks.json or <repo>/.codex/hooks.json). Every entry has a timeout: Codex waits 600
        // seconds by default, and gives SessionEnd 1 to 3 seconds. No command_windows: the plain command is the same on Windows.
        // Built from the Codex hooks documentation, not captured on a real install yet.
        const command = (timeout) => [{ type: 'command', command: bin('codex'), timeout }];
        return JSON.stringify({
            hooks: {
                SessionStart: [{ hooks: command(15) }],
                UserPromptSubmit: [{ hooks: command(10) }],
                PreToolUse: [{ matcher: '^mcp__.*__(item_status|flow_set_status)$', hooks: command(10) }],
                PostToolUse: [
                    {
                        matcher: '^(apply_patch|Edit|Write|Bash|exec_command|mcp__(afb-|agent-flow-board).*)$',
                        hooks: command(10)
                    }
                ],
                Stop: [{ hooks: command(20) }],
                // The conversation ended: the server lets go of this session's claim
                SessionEnd: [{ hooks: command(3) }]
            }
        }, null, 2);
    }
    if (tool === 'gemini') {
        const command = (timeout) => [{ type: 'command', command: bin('gemini'), timeout }];
        return JSON.stringify({
            hooks: {
                SessionStart: [{ hooks: command(15000) }],
                BeforeAgent: [{ hooks: command(10000) }],
                BeforeTool: [{ matcher: 'mcp_.*(item_status|flow_set_status)', hooks: command(10000) }],
                AfterTool: [{ matcher: '.*', hooks: command(10000) }],
                AfterAgent: [{ hooks: command(20000) }]
            }
        }, null, 2);
    }
    return null;
}
