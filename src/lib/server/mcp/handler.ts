// THE /mcp ENDPOINT: STREAMABLE HTTP WITH NO IN MEMORY STATE (SPEC 7)
// Each request builds its own server and transport, answers with plain JSON, and forgets everything. State lives in the
// database (sessions, claims), so the endpoint behaves the same on one server and on several processes.

// -- DEP-MODULES -- //
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { eq } from 'drizzle-orm';
// -- MODULES -- //
import { connectionName, isOrgSlug, orgMcpUrl, toolPrefix } from '../../shared/orgConnection';
import { org } from '../db/schema';
import { withTenant } from '../db/tenant';
import { authenticateToken } from '../ops/tokens';
import { registerCompat } from './compat';
import { registerMockupTools } from './mockupTools';
import { registerNoteTools } from './noteTools';
import { registerTools, type McpDeps } from './tools';
import { SERVER_INSTRUCTIONS } from './workflows';

// -- CONSTANTS -- //

/** Bumped when a tool's input changes in a way an old bridge cannot send (ADR-030, the bridge checks it on start). */
export const MCP_PROTOCOL_VERSION = 2;

// -- FUNCTIONS -- //

/** The discovery document a client reads after a 401. An org address has its own, with the slug inserted after the well known part (RFC 9728). */
const challenge = (baseUrl: string, orgSlug?: string) =>
	`Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource${orgSlug ? `/mcp/${orgSlug}` : ''}"`;

function unauthorized(baseUrl: string, message: string, orgSlug?: string): Response {
	return new Response(
		JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }),
		{
			status: 401,
			headers: {
				'content-type': 'application/json',
				'www-authenticate': challenge(baseUrl, orgSlug),
				'cache-control': 'no-store'
			}
		}
	);
}

const jsonError = (status: number, code: number, message: string) =>
	new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
	});

/**
 * Handles one MCP request. Returns 401 with the OAuth discovery hint when there is no valid token. With an org slug (the
 * /mcp/<slug> address) the token must belong to that org: the address only adds a check, it never widens access.
 */
export async function handleMcp(
	request: Request,
	deps: McpDeps,
	orgSlugRaw?: string
): Promise<Response> {
	const orgSlug = orgSlugRaw?.toLowerCase();
	if (orgSlug !== undefined && !isOrgSlug(orgSlug))
		return jsonError(404, -32004, 'There is no such address.');
	const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
	if (!bearer)
		return unauthorized(
			deps.baseUrl,
			'Sign in with OAuth, a device code or a personal access token.',
			orgSlug
		);
	const auth = await authenticateToken(deps.handle, bearer);
	if (!auth)
		return unauthorized(
			deps.baseUrl,
			'The token is not valid. It may have expired or been revoked.',
			orgSlug
		);
	if (orgSlug) {
		// The slug of the token's own org is compared, the URL slug is never looked up: a wrong org and an unknown slug answer the same
		const own = await withTenant(deps.handle, { orgId: auth.orgId }, async (tx) => {
			const [o] = await tx.select({ slug: org.slug }).from(org).where(eq(org.id, auth.orgId));
			return o?.slug ?? null;
		});
		if (own !== orgSlug)
			return jsonError(
				403,
				-32003,
				`FORBIDDEN: this sign in belongs to a different organisation than the address ${orgMcpUrl(deps.baseUrl, orgSlug)}. Connect again from Connect a tool, with the organisation you want selected.`
			);
	}
	// A stateless endpoint has no event stream to resume, so only POST is served
	if (request.method !== 'POST') {
		return new Response(
			JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST.' }, id: null }),
			{ status: 405, headers: { allow: 'POST', 'content-type': 'application/json' } }
		);
	}
	const server = new McpServer(
		{ name: 'agent-flow-board', version: String(MCP_PROTOCOL_VERSION) },
		{
			// The server name above stays one technical id; the connection name is what the person registered in their tool
			instructions: orgSlug
				? `${SERVER_INSTRUCTIONS}\n\nThis connection is ${connectionName(orgSlug)}, for the organisation ${orgSlug}. Its tools are named ${toolPrefix(orgSlug)}<tool>, so rules and permission lists that name tools must use that prefix.`
				: SERVER_INSTRUCTIONS
		}
	);
	const builder = registerTools(server, deps, auth);
	registerCompat(builder);
	registerMockupTools(builder);
	registerNoteTools(builder);
	// No prompts are registered: the flow skills reach people as a downloaded bundle (the Skills tab on /connect), and the
	// workflow_get tool still serves the same texts, so the slash list of a harness stays free of this server's workflows
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
export function oauthMetadata(baseUrl: string, orgSlug?: string) {
	return {
		protectedResource: {
			resource: orgSlug ? orgMcpUrl(baseUrl, orgSlug) : `${baseUrl}/mcp`,
			authorization_servers: [baseUrl],
			bearer_methods_supported: ['header'],
			scopes_supported: ['read', 'comment', 'write', 'complete', 'delete', 'manage']
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
			scopes_supported: ['read', 'comment', 'write', 'complete', 'delete', 'manage']
		}
	};
}
