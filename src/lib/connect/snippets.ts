// CONNECT SNIPPETS: ONE READY MADE CONFIGURATION PER TOOL (6.12). PURE, SO THE TEXT IS TESTED AND NEVER CONTAINS A SECRET.
// Each organisation has its own connection: the name is afb-<org-slug> and the address is /mcp/<org-slug>, so one person can
// hold several organisations in different folders without the sign ins clashing.

// -- MODULES -- //
import { connectionName, orgMcpUrl } from '../shared/orgConnection';

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

/**
 * Snippets for every supported tool. OAuth tools open a browser to sign in; the rest use a device code or a token.
 * With an org slug the name and the address belong to that org. Without one (no organisation yet) the plain address is shown.
 */
export function snippets(baseUrl: string, orgSlug: string | null = null): Snippet[] {
	const name = orgSlug ? connectionName(orgSlug) : 'agent-flow-board';
	const mcp = orgSlug ? orgMcpUrl(baseUrl, orgSlug) : `${baseUrl}/mcp`;
	return [
		{
			id: 'claude-code',
			label: 'Claude Code',
			signIn: 'Opens your browser to sign in the first time.',
			code: `claude mcp add --transport http ${name} ${mcp}`,
			language: 'bash'
		},
		{
			id: 'claude-ai',
			label: 'Claude chat',
			signIn: `Add it as a custom connector in the Claude app or on claude.ai (Claude chat, not Claude Code), name it ${name}, then sign in when asked.`,
			where: 'Settings, Connectors, Add custom connector',
			code: mcp,
			language: 'bash'
		},
		{
			id: 'vscode',
			label: 'VS Code',
			signIn: 'VS Code opens your browser to sign in.',
			where: '.vscode/mcp.json',
			code: json({ servers: { [name]: { type: 'http', url: mcp } } }),
			language: 'json'
		},
		{
			id: 'antigravity',
			label: 'Antigravity',
			signIn: 'Use the local bridge, which signs in with a device code.',
			where: 'mcp_config.json',
			code: json({
				mcpServers: {
					[name]: {
						command: 'npx',
						args: [
							'-y',
							'@agent-flow-board/bridge',
							'mcp',
							'--server',
							baseUrl,
							...(orgSlug ? ['--org', orgSlug] : [])
						]
					}
				}
			}),
			language: 'json'
		},
		{
			id: 'other',
			label: 'Any other tool',
			signIn:
				'For tools such as Cursor, Windsurf, Codex and Gemini CLI: send a personal access token as a bearer header, or use the local bridge.',
			code: `# Direct, with a personal access token from the section below\nAuthorization: Bearer afb_...\n${mcp}\n\n# Or the local bridge for tools that only speak stdio\nnpx -y @agent-flow-board/bridge mcp --server ${baseUrl}${orgSlug ? ` --org ${orgSlug}` : ''}`,
			language: 'bash'
		}
	];
}
