// GOOGLE PROFILE PICTURE (AFB-20261115-0905): THE SAFE FETCH, WITH A FAKE FETCH AND NO NETWORK

// IMPORTED DEP-MODULES
import { describe, expect, it, vi } from 'vitest';
// IMPORTED MODULES
import {
	fetchGooglePicture,
	googlePictureUrl,
	sniffPictureType
} from '../../src/lib/server/auth/profilePicture';

// -- CONSTANTS -- //

const GOOD = 'https://lh3.googleusercontent.com/a/ACg8ocABC=s96-c';
const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);

// -- FUNCTIONS -- //

const answer = (body: Uint8Array | ReadableStream<Uint8Array>, init: ResponseInit = {}) =>
	new Response(body as BodyInit, { status: 200, ...init });

describe('google profile picture fetch', () => {
	it('only a plain https address on a Google picture host is accepted', () => {
		expect(googlePictureUrl(GOOD)).not.toBeNull();
		for (const bad of [
			null,
			'',
			'not a url',
			'http://lh3.googleusercontent.com/a/x',
			'https://evilgoogleusercontent.com/a/x',
			'https://lh3.googleusercontent.com.evil.test/a/x',
			'https://lh3.googleusercontent.com@evil.test/a/x',
			'https://user:pw@lh3.googleusercontent.com/a/x',
			'https://lh3.googleusercontent.com:8443/a/x',
			'https://docs.googleusercontent.com/a/x',
			'https://169.254.169.254/a/x'
		])
			expect(googlePictureUrl(bad), String(bad)).toBeNull();
	});

	it('reads the type from the bytes', () => {
		expect(sniffPictureType(PNG)).toBe('image/png');
		expect(sniffPictureType(JPEG)).toBe('image/jpeg');
		expect(sniffPictureType(new TextEncoder().encode('<svg xmlns="x"></svg>'))).toBeNull();
		expect(sniffPictureType(new TextEncoder().encode('<html>hi</html>'))).toBeNull();
	});

	it('fetches a picture, asks for the 256 px size and refuses redirects', async () => {
		const f = vi.fn(async () => answer(JPEG, { headers: { 'content-type': 'text/plain' } }));
		const out = await fetchGooglePicture(GOOD, { fetch: f as never });
		expect(out?.mime).toBe('image/jpeg');
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://lh3.googleusercontent.com/a/ACg8ocABC=s256-c');
		expect(init.redirect).toBe('error');
	});

	it('never calls the network for another host', async () => {
		const f = vi.fn();
		expect(await fetchGooglePicture('https://evil.test/a.png', { fetch: f as never })).toBeNull();
		expect(f).not.toHaveBeenCalled();
	});

	it('a body labelled image/png that is not a picture is refused', async () => {
		const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
		const f = async () => answer(svg, { headers: { 'content-type': 'image/png' } });
		expect(await fetchGooglePicture(GOOD, { fetch: f as never })).toBeNull();
	});

	it('an error, a failed status and a redirect all end as null', async () => {
		expect(
			await fetchGooglePicture(GOOD, {
				fetch: (async () => {
					throw new TypeError('redirect mode is set to error');
				}) as never
			})
		).toBeNull();
		expect(
			await fetchGooglePicture(GOOD, {
				fetch: (async () => answer(PNG, { status: 404 })) as never
			})
		).toBeNull();
	});

	it('an oversized body is cut off at the cap, whatever the length header says', async () => {
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(c) {
				pulled += 1;
				c.enqueue(new Uint8Array(100 * 1024));
				if (pulled > 50) c.close();
			}
		});
		const out = await fetchGooglePicture(GOOD, { fetch: (async () => answer(stream)) as never });
		expect(out).toBeNull();
		// It stopped reading soon after 512 KB instead of taking all 5 MB
		expect(pulled).toBeLessThan(20);
		const declared = answer(PNG, { headers: { 'content-length': String(600 * 1024) } });
		expect(await fetchGooglePicture(GOOD, { fetch: (async () => declared) as never })).toBeNull();
	});

	it('a stalled body ends at the timeout', async () => {
		const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
		const started = Date.now();
		const out = await fetchGooglePicture(GOOD, {
			fetch: (async () => answer(stalled)) as never,
			timeoutMs: 100
		});
		expect(out).toBeNull();
		expect(Date.now() - started).toBeLessThan(2000);
	});
});
