// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { imageWidth, sniffImageMime } from '../../src/lib/server/ops/imageType';

// -- HELPERS -- //

const bytes = (...parts: (number[] | string)[]) =>
	Uint8Array.from(
		parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p))
	);
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const box = (type: string, ...payload: (number[] | string)[]) => {
	const body = [...bytes(...payload)];
	return [...be32(8 + body.length), ...bytes(type), ...body];
};

const png = (width: number) =>
	bytes(
		[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		be32(13),
		'IHDR',
		be32(width),
		be32(10),
		[8, 6, 0, 0, 0]
	);
const jpeg = (width: number, sof = 0xc0, pad = 0) =>
	bytes(
		[0xff, 0xd8],
		// An APP1 segment of a chosen size (EXIF) before the frame header
		[0xff, 0xe1],
		be16(pad + 2),
		new Array(pad).fill(0),
		[0xff, sof],
		be16(17),
		[8],
		be16(10),
		be16(width),
		new Array(12).fill(0),
		[0xff, 0xda]
	);
const vp8 = (width: number) =>
	bytes(
		'RIFF',
		[0, 0, 0, 0],
		'WEBP',
		'VP8 ',
		[0, 0, 0, 0],
		[0, 0, 0],
		[0x9d, 0x01, 0x2a],
		le16(width),
		le16(10)
	);
const vp8l = (width: number) => {
	const w = width - 1;
	return bytes(
		'RIFF',
		[0, 0, 0, 0],
		'WEBP',
		'VP8L',
		[0, 0, 0, 0],
		[0x2f],
		[w & 255, (w >> 8) & 63, 0, 0]
	);
};
const vp8x = (width: number) => {
	const w = width - 1;
	return bytes(
		'RIFF',
		[0, 0, 0, 0],
		'WEBP',
		'VP8X',
		[10, 0, 0, 0],
		[0x12, 0, 0, 0],
		[w & 255, (w >> 8) & 255, (w >> 16) & 255],
		[9, 0, 0]
	);
};
/** An AVIF whose primary item (2) uses property 2, and whose thumbnail item (1) uses a smaller ispe as property 1. */
const avif = (width: number, brand = 'avif') => {
	const ispe = (w: number) => box('ispe', [0, 0, 0, 0], be32(w), be32(10));
	const ipco = box('ipco', ...[ispe(40), ispe(width)].map((b) => b));
	const ipma = box('ipma', [0, 0, 0, 0], be32(2), be16(1), [1, 1], be16(2), [1, 2]);
	const iprp = box('iprp', ipco, ipma);
	const pitm = box('pitm', [0, 0, 0, 0], be16(2));
	const meta = box('meta', [0, 0, 0, 0], pitm, iprp);
	return bytes(box('ftyp', brand, [0, 0, 0, 0], 'mif1', brand), meta);
};

// -- TESTS -- //

describe('sniffImageMime and imageWidth', () => {
	it('reads a PNG', () => {
		expect(sniffImageMime(png(1440))).toBe('image/png');
		expect(imageWidth(png(1440), 'image/png')).toBe(1440);
	});

	it('reads a baseline and a progressive JPEG, also after a 65 KB APP1', () => {
		expect(sniffImageMime(jpeg(1440))).toBe('image/jpeg');
		expect(imageWidth(jpeg(1440), 'image/jpeg')).toBe(1440);
		expect(imageWidth(jpeg(390, 0xc2), 'image/jpeg')).toBe(390);
		expect(imageWidth(jpeg(1440, 0xc0, 65_000), 'image/jpeg')).toBe(1440);
	});

	it('reads lossy, lossless and extended WebP', () => {
		for (const [file, w] of [
			[vp8(1440), 1440],
			[vp8l(1440), 1440],
			[vp8x(1440), 1440],
			[vp8x(3000), 3000]
		] as const) {
			expect(sniffImageMime(file)).toBe('image/webp');
			expect(imageWidth(file, 'image/webp')).toBe(w);
		}
	});

	it('reads the primary item width of an AVIF, not its thumbnail', () => {
		expect(sniffImageMime(avif(1440))).toBe('image/avif');
		expect(imageWidth(avif(1440), 'image/avif')).toBe(1440);
	});

	it('refuses an AVIF-looking file with only a heic or mif1 brand', () => {
		expect(sniffImageMime(bytes(box('ftyp', 'heic', [0, 0, 0, 0], 'mif1')))).toBeNull();
	});

	it('refuses truncated files and answers null for their width', () => {
		expect(imageWidth(png(1440).subarray(0, 18), 'image/png')).toBeNull();
		expect(imageWidth(jpeg(1440).subarray(0, 12), 'image/jpeg')).toBeNull();
		expect(imageWidth(vp8(1440).subarray(0, 24), 'image/webp')).toBeNull();
		expect(imageWidth(avif(1440).subarray(0, 60), 'image/avif')).toBeNull();
	});

	it('refuses an SVG, a GIF and an empty file', () => {
		expect(sniffImageMime(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
		expect(sniffImageMime(bytes('GIF89a', [0, 0, 0, 0, 0, 0]))).toBeNull();
		expect(sniffImageMime(new Uint8Array())).toBeNull();
	});

	it('answers null for a zero width', () => {
		expect(imageWidth(png(0), 'image/png')).toBeNull();
		expect(imageWidth(jpeg(0), 'image/jpeg')).toBeNull();
	});

	it('stops a hostile marker loop', () => {
		// Thousands of empty segments with no frame header: the walk is bounded and answers null
		const segment = [0xff, 0xe0, 0x00, 0x02];
		const loop = bytes([0xff, 0xd8], new Array(4000).fill(segment).flat());
		expect(imageWidth(loop, 'image/jpeg')).toBeNull();
		// A real frame header that comes after the bound is not reached either
		const late = bytes(
			[0xff, 0xd8],
			new Array(300).fill(segment).flat(),
			[0xff, 0xc0, 0, 17, 8, 0, 10, 5, 160]
		);
		expect(imageWidth(late, 'image/jpeg')).toBeNull();
		// A DHT segment before the frame header is skipped, not taken for it
		const dht = bytes(
			[0xff, 0xd8, 0xff, 0xc4, 0, 4, 0, 0],
			[0xff, 0xc0, 0, 17, 8, 0, 10, 5, 160],
			new Array(10).fill(0)
		);
		expect(imageWidth(dht, 'image/jpeg')).toBe(1440);
	});
});
