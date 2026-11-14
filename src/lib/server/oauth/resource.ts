// THE `resource` OF AN AUTHORIZATION REQUEST (RFC 8707): A CLIENT SENDS THE MCP ADDRESS IT WAS GIVEN, SO /mcp/<slug> NAMES THE ORG
// One parser, used by the consent page and the decision endpoint, so both read the address the same way.

// IMPORTED MODULES
import { isOrgSlug, orgMcpUrl } from '../../shared/orgConnection';

// -- FUNCTIONS -- //

/**
 * The org slug of an address like https://board.example.com/mcp/arbenger, or null for anything else (the plain /mcp address,
 * another host, a query or fragment, an odd path). Null means the person picks the org, exactly as before.
 */
export function orgSlugFromResource(
	resource: string | null | undefined,
	baseUrl: string
): string | null {
	if (!resource) return null;
	let url: URL;
	try {
		url = new URL(resource);
	} catch {
		return null;
	}
	if (url.origin !== new URL(baseUrl).origin || url.search || url.hash) return null;
	const match = /^\/mcp\/([A-Za-z0-9-]+)\/?$/.exec(url.pathname);
	const slug = match?.[1].toLowerCase();
	return slug && isOrgSlug(slug) ? slug : null;
}

/** The canonical form stored with an approval: no trailing slash, lower case slug. */
export const canonicalResource = (baseUrl: string, slug: string) => orgMcpUrl(baseUrl, slug);
