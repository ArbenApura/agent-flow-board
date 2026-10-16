// CONNECT SNIPPETS: ONE READY MADE CONFIGURATION PER TOOL (6.12). PURE, SO THE TEXT IS TESTED AND NEVER CONTAINS A SECRET.

// -- TYPES -- //

export type Snippet = {
	id: string;
	label: string;
	/** One plain sentence on how the tool signs in. */
	signIn: string;
	/** Where the configuration goes, when it is a file. */
	where?: string;
	code: string;
	language: 'bash' | 'json' | 'toml';
};

// -- FUNCTIONS -- //

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** Snippets for every supported tool. OAuth tools open a browser to sign in; the rest use a device code or a token. */
export function snippets(baseUrl: string): Snippet[] {
	const mcp = `${baseUrl}/mcp`;
	return [
		{
			id: 'claude-code',
			label: 'Claude Code',
			signIn: 'Opens your browser to sign in the first time.',
			code: `claude mcp add --transport http agent-flow-board ${mcp}`,
			language: 'bash'
		},
		{
			id: 'claude-ai',
			label: 'claude.ai',
			signIn: 'Add it as a custom connector, then sign in when asked.',
			where: 'Settings, Connectors, Add custom connector',
			code: mcp,
			language: 'bash'
		},
		{
			id: 'cursor',
			label: 'Cursor',
			signIn: 'Cursor opens your browser to sign in.',
			where: '~/.cursor/mcp.json',
			code: json({ mcpServers: { 'agent-flow-board': { url: mcp } } }),
			language: 'json'
		},
		{
			id: 'vscode',
			label: 'VS Code',
			signIn: 'VS Code opens your browser to sign in.',
			where: '.vscode/mcp.json',
			code: json({ servers: { 'agent-flow-board': { type: 'http', url: mcp } } }),
			language: 'json'
		},
		{
			id: 'windsurf',
			label: 'Windsurf',
			signIn: 'Windsurf opens your browser to sign in.',
			where: '~/.codeium/windsurf/mcp_config.json',
			code: json({ mcpServers: { 'agent-flow-board': { serverUrl: mcp } } }),
			language: 'json'
		},
		{
			id: 'codex',
			label: 'Codex',
			signIn: 'Run codex mcp login after adding it.',
			where: '~/.codex/config.toml',
			code: `[mcp_servers.agent-flow-board]\nurl = "${mcp}"`,
			language: 'toml'
		},
		{
			id: 'gemini-cli',
			label: 'Gemini CLI',
			signIn: 'Gemini CLI opens your browser to sign in.',
			where: '~/.gemini/settings.json',
			code: json({ mcpServers: { 'agent-flow-board': { httpUrl: mcp } } }),
			language: 'json'
		},
		{
			id: 'antigravity',
			label: 'Antigravity',
			signIn: 'Use the local bridge, which signs in with a device code.',
			where: 'mcp_config.json',
			code: json({
				mcpServers: {
					'agent-flow-board': {
						command: 'npx',
						args: ['-y', '@agent-flow-board/bridge', 'mcp', '--server', baseUrl]
					}
				}
			}),
			language: 'json'
		},
		{
			id: 'other',
			label: 'Any other tool',
			signIn: 'Send a personal access token as a bearer header, or use the local bridge.',
			code: `# Direct, with a personal access token from the section below\nAuthorization: Bearer afb_...\n${mcp}\n\n# Or the local bridge for tools that only speak stdio\nnpx -y @agent-flow-board/bridge mcp --server ${baseUrl}`,
			language: 'bash'
		}
	];
}
