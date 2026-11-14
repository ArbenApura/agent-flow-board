// HOW MUCH OF A REQUEST BODY THE API READS, BY ENDPOINT: THE DECLARED SIZE IS CHECKED FIRST AND THE STREAM IS CUT AT THE LIMIT

// -- MODULES -- //
import { NOTE_LIMITS } from '../../shared/notes';
import { MAX_MOCKUP_BYTES, MAX_SCREENSHOT_BYTES } from '../ops/mockups';
import { MAX_BODY_BYTES } from './dispatch';

// -- CONSTANTS -- //

/** A JSON body of a mockup call (notes, a pin, settings) is text, never a file. */
const MOCKUP_JSON_BYTES = 1024 * 1024;
/** The body of a live editing call: base64 of a few updates of 256 KB. */
const LIVE_JSON_BYTES = 2 * 1024 * 1024;
/** A little room over the file cap for the request's own framing. */
const SLACK = 64 * 1024;

// -- FUNCTIONS -- //

/** The most bytes this endpoint reads. Everything else keeps the general limit. */
export function bodyLimit(method: string, path: string): number {
	if (method === 'GET' || method === 'DELETE') return 0;
	// A note picture goes up as the raw body; the cap is the picture limit, read while it streams in
	if (/^\/orgs\/[^/]+\/projects\/[^/]+\/notes\/[^/]+\/files\/?$/.test(path) && method === 'POST')
		return NOTE_LIMITS.pictureBytes + SLACK;
	// Live editing calls are small JSON; a few updates of the largest size still fit
	if (/^\/orgs\/[^/]+\/projects\/[^/]+\/notes\/[^/]+\/live\//.test(path)) return LIVE_JSON_BYTES;
	if (/^\/orgs\/[^/]+\/mockups\/?$/.test(path) && method === 'POST')
		return MAX_MOCKUP_BYTES + SLACK;
	// A bundle is JSON that holds the parts as strings, so escaping makes it a little bigger than the page it makes
	if (/^\/orgs\/[^/]+\/mockups\/bundle\/?$/.test(path) && method === 'POST')
		return MAX_MOCKUP_BYTES * 2 + SLACK;
	if (/^\/orgs\/[^/]+\/projects\/[^/]+\/mockup-kit\/?$/.test(path) && method === 'PUT')
		return MAX_MOCKUP_BYTES + SLACK;
	if (/^\/orgs\/[^/]+\/mockups\/[^/]+\/versions\/\d+\/screenshot\/?$/.test(path))
		return MAX_SCREENSHOT_BYTES + SLACK;
	// A render is a picture as base64 text and the rendered tree, in one JSON body
	if (/^\/orgs\/[^/]+\/mockups\/[^/]+\/versions\/\d+\/renders\/?$/.test(path) && method === 'PUT')
		return Math.ceil(MAX_SCREENSHOT_BYTES * 1.4) + MOCKUP_JSON_BYTES + SLACK;
	if (/^\/orgs\/[^/]+\/(mockups|mockup-pins|projects\/[^/]+\/mockup-)/.test(path))
		return MOCKUP_JSON_BYTES;
	return MAX_BODY_BYTES + 1;
}

/** Reads the body up to the limit. Null means it was larger, which is decided from the declared size or while reading. */
export async function readBodyCapped(request: Request, limit: number): Promise<Uint8Array | null> {
	const declared = Number(request.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > limit) return null;
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}
