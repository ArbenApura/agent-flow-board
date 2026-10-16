// THE HOOK SETTINGS EACH TOOL NEEDS, PRINTED FOR THE PERSON TO PASTE. THE BRIDGE NEVER EDITS A TOOL'S SETTINGS BY ITSELF.
// Hook commands carry no quotes around their paths, so they work where a shell strips them (cmd /c on Windows).

// -- FUNCTIONS -- //

/** The settings block for one tool, or null for a name that is not known. */
export function hookSettings(tool: string, server: string): string | null {
	const bin = (adapter: string, event = '') =>
		`agent-flow-board hook ${adapter}${event ? ` ${event}` : ''} --server ${server}`;
	if (tool === 'claude' || tool === 'claude-code') {
		const command = (timeout: number) => [{ type: 'command', command: bin('claude'), timeout }];
		return JSON.stringify(
			{
				hooks: {
					SessionStart: [{ hooks: command(15) }],
					UserPromptSubmit: [{ hooks: command(10) }],
					PreToolUse: [{ matcher: '^mcp__.*__(item_status|flow_set_status)$', hooks: command(10) }],
					PostToolUse: [{ matcher: '.*', hooks: command(10) }],
					Stop: [{ hooks: command(20) }]
				}
			},
			null,
			2
		);
	}
	if (tool === 'antigravity' || tool === 'agy') {
		const at = (event: string, timeout: number) => ({
			type: 'command',
			command: bin('antigravity', event),
			timeout
		});
		return JSON.stringify(
			{
				'agent-flow-board': {
					PostToolUse: [{ matcher: '*', hooks: [at('PostToolUse', 15)] }],
					PreInvocation: [at('PreInvocation', 25)],
					Stop: [at('Stop', 25)]
				}
			},
			null,
			2
		);
	}
	if (tool === 'gemini') {
		const command = (timeout: number) => [{ type: 'command', command: bin('gemini'), timeout }];
		return JSON.stringify(
			{
				hooks: {
					SessionStart: [{ hooks: command(15000) }],
					BeforeAgent: [{ hooks: command(10000) }],
					BeforeTool: [{ matcher: 'mcp_.*(item_status|flow_set_status)', hooks: command(10000) }],
					AfterTool: [{ matcher: '.*', hooks: command(10000) }],
					AfterAgent: [{ hooks: command(20000) }]
				}
			},
			null,
			2
		);
	}
	return null;
}
