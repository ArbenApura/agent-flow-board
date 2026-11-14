// VALIDATES AN AUTHORIZATION REQUEST BEFORE THE CONSENT PAGE SHOWS ANYTHING (OAUTH 2.1)
// A bad client or a redirect address the client did not register is shown as an error on this site and never redirected to.

// IMPORTED TYPES
import type { DbHandle } from '../db/client';
import type { Capability } from '../ops/context';
// IMPORTED MODULES
import { getClient, parseScopes, redirectHost, isOAuthError } from './oauth';

// -- TYPES -- //

export type AuthorizeRequest = {
	clientId: string;
	clientName: string;
	verified: boolean;
	redirectUri: string;
	redirectHost: string;
	challenge: string;
	state: string;
	scopes: Capability[];
};

// -- FUNCTIONS -- //

/** Returns the checked request, or a plain message saying what is wrong with it. */
export async function checkAuthorize(
	handle: DbHandle,
	params: URLSearchParams
): Promise<{ ok: true; request: AuthorizeRequest } | { ok: false; problem: string }> {
	if (params.get('response_type') !== 'code')
		return {
			ok: false,
			problem: 'The tool did not ask for an authorization code, the only kind this server gives.'
		};
	const client = await getClient(handle, params.get('client_id') ?? '');
	if (!client)
		return {
			ok: false,
			problem:
				'This tool is not registered with this server. Start the connection from the tool again.'
		};
	const redirectUri = params.get('redirect_uri') ?? '';
	if (!client.redirectUris.includes(redirectUri))
		return {
			ok: false,
			problem:
				'The address the tool wants to return to does not match the one it registered, so nothing was sent there.'
		};
	if (
		params.get('code_challenge_method') !== 'S256' ||
		!/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') ?? '')
	)
		return {
			ok: false,
			problem: 'The tool did not send a PKCE S256 code challenge, which this server requires.'
		};
	const scopes = parseScopes(params.get('scope') ?? undefined);
	if (isOAuthError(scopes)) return { ok: false, problem: scopes.error_description };
	return {
		ok: true,
		request: {
			clientId: client.id,
			clientName: client.name,
			verified: client.verified,
			redirectUri,
			redirectHost: redirectHost(redirectUri),
			challenge: params.get('code_challenge')!,
			state: params.get('state') ?? '',
			scopes
		}
	};
}

/** The address the person is sent back to, with the code or the refusal and the tool's own state value. */
export function callbackUrl(redirectUri: string, query: Record<string, string>): string {
	const u = new URL(redirectUri);
	for (const [k, v] of Object.entries(query)) if (v !== '') u.searchParams.set(k, v);
	return u.toString();
}
