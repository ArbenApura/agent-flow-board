/* eslint-disable @typescript-eslint/no-explicit-any -- tool replies are parsed from JSON and read loosely in tests */
// A REAL MCP CLIENT TALKING TO THE /mcp HANDLER IN PROCESS, WITH NO HTTP SERVER IN BETWEEN

// -- DEP-MODULES -- //
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
// -- MODULES -- //
import { handleMcp } from '../../src/lib/server/mcp/handler';
import type { McpDeps } from '../../src/lib/server/mcp/tools';

// -- FUNCTIONS -- //

/** Connects a client that sends every request straight into handleMcp with the given bearer token. */
export async function connect(deps: McpDeps, token: string, name = 'test-client') {
	const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) =>
		handleMcp(new Request(input as string, init), deps);
	const transport = new StreamableHTTPClientTransport(new URL(`${deps.baseUrl}/mcp`), {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
		fetch: fetchImpl as typeof fetch
	});
	const client = new Client({ name, version: '1.0.0' });
	await client.connect(transport);
	return client;
}

/** Calls a tool and returns its structured result, throwing nothing: errors come back as { error }. */
export async function call(
	client: Client,
	name: string,
	args: Record<string, unknown> = {}
): Promise<Record<string, any>> {
	const res = await client.callTool({ name, arguments: args });
	return (res.structuredContent ??
		JSON.parse((res.content as { text: string }[])[0].text)) as Record<string, any>;
}
