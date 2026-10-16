// -- DEP-TYPES -- //
import type { RequestHandler } from './$types';
// -- MODULES -- //
import { getDb } from '#lib/server/db/index.js';
import { githubConfig } from '#lib/server/github/index.js';
import { handleWebhook, verifySignature } from '#lib/server/github/webhook.js';
import { getGithub } from '#lib/server/github/index.js';

// -- CONSTANTS -- //

const MAX_BODY = 1_000_000;

// -- FUNCTIONS -- //

/**
 * GitHub's webhooks. Refused without the shared secret and without a valid signature of the raw body, and the answer says
 * nothing about which installations exist.
 */
export const POST: RequestHandler = async ({ request }) => {
	const secret = githubConfig()?.webhookSecret;
	if (!secret) return new Response('Webhooks are not set up on this server.', { status: 404 });
	const length = Number(request.headers.get('content-length') ?? 0);
	if (length > MAX_BODY) return new Response('Too large', { status: 413 });
	const raw = await request.text();
	if (raw.length > MAX_BODY) return new Response('Too large', { status: 413 });
	if (!(await verifySignature(secret, raw, request.headers.get('x-hub-signature-256'))))
		return new Response('Bad signature', { status: 401 });
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return new Response('Not JSON', { status: 400 });
	}
	const result = await handleWebhook(
		await getDb(),
		request.headers.get('x-github-event') ?? '',
		payload,
		{ github: getGithub() ?? undefined }
	);
	return new Response(JSON.stringify({ ok: true }), {
		status: result.handled ? 200 : 202,
		headers: { 'content-type': 'application/json' }
	});
};
