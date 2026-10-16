// THE /mcp ENDPOINT: STREAMABLE HTTP WITH NO IN MEMORY STATE (SPEC 7)
// Each request builds its own server and transport, answers with plain JSON, and forgets everything. State lives in the
// database (sessions, claims), so the endpoint behaves the same on a VPS, on several processes and in a Cloudflare Worker.

// -- DEP-MODULES -- //
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
// -- MODULES -- //
import { authenticateToken } from '../ops/tokens';
import { registerCompat } from './compat';
import { registerTools, type McpDeps } from './tools';
import { SERVER_INSTRUCTIONS, WORKFLOWS } from './workflows';

// -- CONSTANTS -- //

/** Bumped when a tool's input changes in a way an old bridge cannot send (ADR-030, the bridge checks it on start). */
export const MCP_PROTOCOL_VERSION = 1;

// -- FUNCTIONS -- //

const challenge = (baseUrl: string) =>
	`Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`;

function unauthorized(baseUrl: string, message: string): Response {
	return new Response(
		JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }),
		{
			status: 401,
			headers: {
				'content-type': 'application/json',
				'www-authenticate': challenge(baseUrl),
				'cache-control': 'no-store'
			}
		}
	);
}

/** Handles one MCP request. Returns 401 with the OAuth discovery hint when there is no valid token. */
export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
	const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
	if (!bearer)
		return unauthorized(
			deps.baseUrl,
			'Sign in with OAuth, a device code or a personal access token.'
		);
	const auth = await authenticateToken(deps.handle, bearer);
	if (!auth)
		return unauthorized(
			deps.baseUrl,
			'The token is not valid. It may have expired or been revoked.'
		);
	// A stateless endpoint has no event stream to resume, so only POST is served
	if (request.method !== 'POST') {
		return new Response(
			JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST.' }, id: null }),
			{ status: 405, headers: { allow: 'POST', 'content-type': 'application/json' } }
		);
	}
	const server = new McpServer(
		{ name: 'agent-flow-board', version: String(MCP_PROTOCOL_VERSION) },
		{ instructions: SERVER_INSTRUCTIONS }
	);
	const builder = registerTools(server, deps, auth);
	registerCompat(builder);
	for (const w of WORKFLOWS) {
		server.registerPrompt(
			w.name,
			{
				title: w.title,
				description: w.summary,
				argsSchema: { item: z.string().optional().describe('The item you are working on, if any') }
			},
			async ({ item }) => ({
				messages: [
					{
						role: 'user',
						content: {
							type: 'text',
							text: `${w.body}${item ? `\n\nThe user is working on ${item}. Call work_start for it first.` : ''}`
						}
					}
				]
			})
		);
	}
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	await server.connect(transport);
	try {
		const res = await transport.handleRequest(request);
		const headers = new Headers(res.headers);
		headers.set('cache-control', 'no-store');
		headers.set('x-afb-protocol', String(MCP_PROTOCOL_VERSION));
		return new Response(res.body, { status: res.status, headers });
	} finally {
		// The transport and server are per request, so both are closed when the answer is out
		void server.close().catch(() => undefined);
	}
}

/** The two OAuth discovery documents MCP clients read first (RFC 9728 and RFC 8414). */
export function oauthMetadata(baseUrl: string) {
	return {
		protectedResource: {
			resource: `${baseUrl}/mcp`,
			authorization_servers: [baseUrl],
			bearer_methods_supported: ['header'],
			scopes_supported: ['read', 'comment', 'write', 'complete', 'delete', 'publish', 'manage']
		},
		authorizationServer: {
			issuer: baseUrl,
			authorization_endpoint: `${baseUrl}/oauth/authorize`,
			token_endpoint: `${baseUrl}/oauth/token`,
			registration_endpoint: `${baseUrl}/oauth/register`,
			device_authorization_endpoint: `${baseUrl}/oauth/device/code`,
			response_types_supported: ['code'],
			grant_types_supported: [
				'authorization_code',
				'refresh_token',
				'urn:ietf:params:oauth:grant-type:device_code'
			],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none'],
			scopes_supported: ['read', 'comment', 'write', 'complete', 'delete', 'publish', 'manage']
		}
	};
}
