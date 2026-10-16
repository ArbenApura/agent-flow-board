// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import { exchangeCode, isOAuthError, pollDevice, refreshTokens } from '#lib/server/oauth/oauth.js';
import { json, preflight, readParams } from '#lib/server/oauth/http.js';

// -- CONSTANTS -- //

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

// -- FUNCTIONS -- //

export const OPTIONS: RequestHandler = () => preflight();

/** The token endpoint: authorization code with PKCE, refresh token and device code. Public clients only, no client secret. */
export const POST: RequestHandler = async ({ request }) => {
	const p = await readParams(request);
	const handle = await getDb();
	let result;
	if (p.grant_type === 'authorization_code')
		result = await exchangeCode(handle, {
			code: p.code ?? '',
			redirectUri: p.redirect_uri ?? '',
			verifier: p.code_verifier ?? '',
			clientId: p.client_id ?? ''
		});
	else if (p.grant_type === 'refresh_token')
		result = await refreshTokens(handle, {
			refreshToken: p.refresh_token ?? '',
			clientId: p.client_id ?? ''
		});
	else if (p.grant_type === DEVICE_GRANT) result = await pollDevice(handle, p.device_code ?? '');
	else
		return json(
			{
				error: 'unsupported_grant_type',
				error_description: 'Use authorization_code, refresh_token or the device code grant.'
			},
			400
		);
	return isOAuthError(result)
		? json(
				result,
				result.error === 'slow_down' || result.error === 'authorization_pending' ? 400 : 400
			)
		: json(result);
};
