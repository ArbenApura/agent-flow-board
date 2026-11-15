// GOOGLE PROFILE PICTURE (AFB-20261115-0905): A PERSON WHO SIGNS IN WITH GOOGLE GETS THEIR GOOGLE PICTURE AS THE DEFAULT AVATAR
// Better Auth stores Google's picture address in user.image. No page loads another site's picture, so after a successful sign in
// the bytes are fetched once, checked, and kept as the same data address an upload uses. A failure never touches the sign in.

// IMPORTED TYPES
import type { DbHandle } from '../db/client';
// IMPORTED DEP-MODULES
import { eq } from 'drizzle-orm';
// IMPORTED CONSTANTS
import { MAX_PICTURE_BYTES } from '../../shared/pictures';
// IMPORTED MODULES
import { user } from '../db/schema';
import { adoptProviderAvatar } from '../ops/pictures';

// -- TYPES -- //

export type PictureType = 'image/png' | 'image/jpeg' | 'image/webp';
export type FetchedPicture = { bytes: Uint8Array; mime: PictureType };
export type PictureFetchOptions = {
	/** Replaceable in tests. */
	fetch?: typeof fetch;
	/** One limit over connecting, the headers and the whole body. */
	timeoutMs?: number;
};

// -- CONSTANTS -- //

/** Only Google's own picture hosts. A wider *.googleusercontent.com would include places that serve other people's files. */
const GOOGLE_PICTURE_HOST = /^lh[0-9]+\.googleusercontent\.com$/;
const DEFAULT_TIMEOUT_MS = 3000;
/** Google resizes on request. 256 px is plenty for an avatar and keeps the file well under the cap. */
const SIZE_SUFFIX = '=s256-c';

// -- FUNCTIONS -- //

/** The address as a URL when it is a plain https address on a Google picture host, else null. */
export function googlePictureUrl(raw: string | null | undefined): URL | null {
	if (!raw) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
	if (!GOOGLE_PICTURE_HOST.test(url.hostname)) return null;
	return url;
}

/** The picture type read from the first bytes, never from what the server claims. */
export function sniffPictureType(bytes: Uint8Array): PictureType | null {
	const b = bytes;
	if (
		b.length >= 8 &&
		b[0] === 137 &&
		b[1] === 80 &&
		b[2] === 78 &&
		b[3] === 71 &&
		b[4] === 13 &&
		b[5] === 10 &&
		b[6] === 26 &&
		b[7] === 10
	)
		return 'image/png';
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
	if (
		b.length >= 12 &&
		String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' &&
		String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP'
	)
		return 'image/webp';
	return null;
}

/** Asks for the 256 px version of the picture, whatever size the stored address names. */
function sized(url: URL): URL {
	const out = new URL(url.toString());
	out.pathname = out.pathname.replace(/=s\d+(-c)?$/, '') + SIZE_SUFFIX;
	return out;
}

/**
 * Downloads a Google profile picture. Returns null for anything that is not a small PNG, JPEG or WebP from a Google picture
 * host: another host, a redirect, a slow or oversized answer, a failed request. It never throws.
 */
export async function fetchGooglePicture(
	raw: string | null | undefined,
	options: PictureFetchOptions = {}
): Promise<FetchedPicture | null> {
	const url = googlePictureUrl(raw);
	if (!url) return null;
	const doFetch = options.fetch ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const aborted = new Promise<never>((_, reject) =>
		controller.signal.addEventListener('abort', () => reject(new Error('timeout')))
	);
	// A rejection nobody awaits (the read finished first) must not become an unhandled rejection
	aborted.catch(() => {});
	try {
		// A redirect is an error: the check above only vouched for this one address
		const res = await Promise.race([
			doFetch(sized(url).toString(), { redirect: 'error', signal: controller.signal }),
			aborted
		]);
		if (!res.ok || !res.body) return null;
		const declared = Number(res.headers.get('content-length'));
		if (declared > MAX_PICTURE_BYTES) return null;
		// Read in pieces and stop at the cap: a missing or false length header cannot make the server hold the whole body
		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), aborted]);
			if (done) break;
			total += value.byteLength;
			if (total > MAX_PICTURE_BYTES) {
				await reader.cancel().catch(() => {});
				return null;
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(total);
		let at = 0;
		for (const c of chunks) {
			bytes.set(c, at);
			at += c.byteLength;
		}
		const mime = sniffPictureType(bytes);
		return mime ? { bytes, mime } : null;
	} catch (e) {
		// Host and reason only: the address and the body stay out of the log
		console.warn(`[auth] Google picture not imported (${url.hostname}): ${(e as Error).message}`);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * After a successful sign in: when the person's user.image is still a Google picture address, fetch it and keep the bytes in
 * its place. Anything else is left alone: an uploaded picture, and an empty value (a removed picture stays removed).
 * Returns whether a picture was stored. Never throws.
 */
export async function adoptGooglePicture(
	handle: DbHandle,
	userId: string,
	options: PictureFetchOptions = {}
): Promise<boolean> {
	try {
		const [row] = await handle.db
			.select({ image: user.image })
			.from(user)
			.where(eq(user.id, userId));
		const address = row?.image;
		if (!googlePictureUrl(address)) return false;
		const picture = await fetchGooglePicture(address, options);
		if (!picture) return false;
		return await adoptProviderAvatar(
			handle,
			userId,
			address as string,
			picture.bytes,
			picture.mime
		);
	} catch (e) {
		console.warn(`[auth] Google picture not stored: ${(e as Error).message}`);
		return false;
	}
}
