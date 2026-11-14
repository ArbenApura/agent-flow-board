// DEVICE CODE SIGN IN FOR THE BRIDGE (RFC 8628). THE PERSON TYPES THE CODE ON THE SERVER'S /device PAGE; NOTHING IS PRE FILLED.

// IMPORTED DEP-MODULES
import { createHash, randomBytes } from 'node:crypto';

// -- TYPES -- //

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export type DeviceResult = { token: string; expiresInSeconds: number };

// -- FUNCTIONS -- //

/** How long one sign in call may take. The wait between polls is separate. */
export const DEVICE_CALL_TIMEOUT_MS = 30_000;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deviceLogin(
	server: string,
	fetchImpl: Fetch,
	log: (line: string) => void,
	options: {
		name?: string;
		wait?: (ms: number) => Promise<unknown>;
		/**
		 * Keep a verifier and send only its SHA-256 with the code, so an agent that holds both can approve the code through MCP
		 * (tool_connection_approve) and only the tool that started it can be approved. The verifier is handed to `onCode`, never logged.
		 */
		pkce?: boolean;
		onCode?: (code: {
			userCode: string;
			verifier: string | null;
			verificationUri: string;
			expiresInSeconds: number;
		}) => void;
	} = {}
): Promise<DeviceResult> {
	const wait = options.wait ?? sleep;
	const verifier = options.pkce ? randomBytes(32).toString('base64url') : null;
	const start = await fetchImpl(`${server}/oauth/device/code`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			client_name: options.name ?? 'agent-flow-board bridge',
			...(verifier
				? {
						code_challenge: createHash('sha256').update(verifier).digest('base64url'),
						code_challenge_method: 'S256'
					}
				: {})
		}),
		signal: AbortSignal.timeout(DEVICE_CALL_TIMEOUT_MS)
	});
	if (!start.ok) throw new Error(`The server refused the sign in (${start.status}).`);
	const d = (await start.json()) as {
		device_code: string;
		user_code: string;
		verification_uri: string;
		expires_in: number;
		interval: number;
	};
	options.onCode?.({
		userCode: d.user_code,
		verifier,
		verificationUri: d.verification_uri,
		expiresInSeconds: d.expires_in
	});
	log(`To sign in, open ${d.verification_uri} and type this code: ${d.user_code}`);
	log(
		`The code works for ${Math.floor(d.expires_in / 60)} minutes. Waiting for you to approve it...`
	);
	let interval = d.interval * 1000;
	const deadline = Date.now() + d.expires_in * 1000;
	while (Date.now() < deadline) {
		await wait(interval);
		const res = await fetchImpl(`${server}/oauth/token`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				device_code: d.device_code
			}).toString(),
			signal: AbortSignal.timeout(DEVICE_CALL_TIMEOUT_MS)
		});
		const body = (await res.json()) as {
			access_token?: string;
			expires_in?: number;
			error?: string;
			error_description?: string;
		};
		if (body.access_token)
			return { token: body.access_token, expiresInSeconds: body.expires_in ?? 0 };
		if (body.error === 'authorization_pending') continue;
		if (body.error === 'slow_down') {
			interval += 5000;
			continue;
		}
		throw new Error(body.error_description ?? body.error ?? 'The sign in failed.');
	}
	throw new Error('The code expired before it was approved. Run the command again.');
}
