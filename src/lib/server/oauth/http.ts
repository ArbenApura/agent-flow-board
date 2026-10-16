// SMALL HTTP HELPERS FOR THE OAUTH ENDPOINTS. THEY ARE CALLED BY TOOLS, NOT BROWSERS WITH COOKIES, SO CORS IS OPEN AND CREDENTIALS ARE NEVER SENT.

// -- CONSTANTS -- //

const CORS = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'POST, OPTIONS',
	'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
	'cache-control': 'no-store',
	pragma: 'no-cache'
};

// -- FUNCTIONS -- //

export const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...CORS }
	});
export const preflight = () => new Response(null, { status: 204, headers: CORS });

/** Reads a form or JSON body into plain strings. Anything else is empty. */
export async function readParams(request: Request): Promise<Record<string, string>> {
	const type = request.headers.get('content-type') ?? '';
	try {
		if (type.includes('application/json'))
			return Object.fromEntries(
				Object.entries((await request.json()) as Record<string, unknown>).filter(
					([, v]) => typeof v === 'string'
				)
			) as Record<string, string>;
		if (type.includes('application/x-www-form-urlencoded'))
			return Object.fromEntries(new URLSearchParams(await request.text()));
	} catch {
		/* fall through */
	}
	return {};
}
