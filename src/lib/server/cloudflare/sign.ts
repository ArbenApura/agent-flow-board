// THE SIGNATURE THE QUEUE CONSUMER PUTS ON A JOB BODY, SO ONLY THE WORKER ITSELF CAN RUN A JOB (SPEC 12)
// HMAC-SHA-256 with Web Crypto, so the same function runs in the Worker entry and in the app.

// -- FUNCTIONS -- //

/** The hex HMAC of a body under a secret. The domain tag keeps the key from signing anything else the app might sign. */
export async function signBody(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(`afb-internal-job-v1:${secret}`),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
