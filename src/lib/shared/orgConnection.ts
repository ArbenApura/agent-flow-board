// THE PER ORGANISATION MCP CONNECTION: ONE NAME AND ONE ADDRESS PER ORG (ADR ORG MCP URL). PURE, SO THE SERVER, THE CONNECT PAGE AND THE BRIDGE AGREE.

// -- CONSTANTS -- //

/** An org slug as the app writes it (zod.ts orgInsert), lowercase letters, digits and dashes. */
export const ORG_SLUG = /^[a-z0-9][a-z0-9-]{1,38}$/;
/** The name a tool registers the connection under, so two orgs never share a sign in or a tool prefix. */
export const CONNECTION_PREFIX = 'afb-';

// -- FUNCTIONS -- //

export const isOrgSlug = (value: unknown): value is string =>
	typeof value === 'string' && ORG_SLUG.test(value);

/** The server name a tool registers for one org, for example afb-arbenger. */
export const connectionName = (slug: string) => `${CONNECTION_PREFIX}${slug}`;

/** The tool prefix an agent sees for that connection, for example mcp__afb-arbenger__. */
export const toolPrefix = (slug: string) => `mcp__${connectionName(slug)}__`;

/** The MCP address of one org. */
export const orgMcpUrl = (baseUrl: string, slug: string) => `${baseUrl}/mcp/${slug}`;
