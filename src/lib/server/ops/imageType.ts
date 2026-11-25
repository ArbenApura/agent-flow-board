// SCREEN PICTURE TYPES: PNG, JPEG, WEBP AND AVIF TOLD APART AND MEASURED FROM THEIR BYTES (AFB-20261125-1628)
// The type is never taken from a file name, a header or what the sender says. Nothing is decoded: only the header fields that
// carry the pixel width are read. Every reader fails closed: a short, odd or truncated header answers null, and every loop is
// bounded by a count and by the buffer length.

// -- CONSTANTS -- //

export const SCREEN_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'] as const;
export type ScreenMime = (typeof SCREEN_MIMES)[number];

/** The file extension each stored type is written with. */
export const SCREEN_EXTENSIONS: Record<ScreenMime, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/avif': 'avif'
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The most JPEG segments or MP4 boxes one reader walks, so a hostile file cannot keep it busy. */
const MAX_STEPS = 256;

// -- FUNCTIONS -- //

const ascii = (b: Uint8Array, at: number, n: number) =>
	at + n <= b.byteLength ? String.fromCharCode(...b.subarray(at, at + n)) : '';
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32be = (b: Uint8Array, at: number) =>
	((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

/** The type of a picture from its signature, or null when it is none of the four. */
export function sniffImageMime(bytes: Uint8Array): ScreenMime | null {
	if (bytes.byteLength >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v)) return 'image/png';
	if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return 'image/jpeg';
	if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
	if (ascii(bytes, 4, 4) === 'ftyp' && avifBrand(bytes)) return 'image/avif';
	return null;
}

/** The pixel width of a picture of a known type, or null when its header is missing, truncated or says zero. */
export function imageWidth(bytes: Uint8Array, mime: ScreenMime): number | null {
	const w =
		mime === 'image/png'
			? pngWidth(bytes)
			: mime === 'image/jpeg'
				? jpegWidth(bytes)
				: mime === 'image/webp'
					? webpWidth(bytes)
					: avifWidth(bytes);
	return w !== null && w > 0 ? w : null;
}

// -- PNG -- //

/** The width from the first chunk (IHDR). */
function pngWidth(b: Uint8Array): number | null {
	if (b.byteLength < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
	return u32be(b, 16);
}

// -- JPEG -- //

/** Walks the segments by their length field to the first start-of-frame marker and reads the width there. */
function jpegWidth(b: Uint8Array): number | null {
	let i = 2;
	for (let n = 0; n < MAX_STEPS; n++) {
		// Fill bytes before a marker are allowed
		while (i < b.byteLength && b[i] === 0xff && b[i + 1] === 0xff) i++;
		if (i + 4 > b.byteLength || b[i] !== 0xff) return null;
		const marker = b[i + 1];
		// The image data starts at SOS and the frame header must come first
		if (marker === 0xda || marker === 0xd9) return null;
		// Markers with no length: TEM, RSTn, SOI
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
			i += 2;
			continue;
		}
		const len = u16be(b, i + 2);
		if (len < 2) return null;
		// SOF0 to SOF15 except DHT (C4), JPG (C8) and DAC (CC)
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (len < 8 || i + 9 > b.byteLength) return null;
			return u16be(b, i + 7);
		}
		i += 2 + len;
	}
	return null;
}

// -- WEBP -- //

/** Lossy (VP8), lossless (VP8L) and extended (VP8X, also animated) all carry the width in their first chunk. */
function webpWidth(b: Uint8Array): number | null {
	const kind = ascii(b, 12, 4);
	if (kind === 'VP8 ') {
		if (b.byteLength < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
		return (b[26] | (b[27] << 8)) & 0x3fff;
	}
	if (kind === 'VP8L') {
		if (b.byteLength < 25 || b[20] !== 0x2f) return null;
		return ((b[21] | (b[22] << 8)) & 0x3fff) + 1;
	}
	if (kind === 'VP8X') {
		if (b.byteLength < 30) return null;
		return (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
	}
	return null;
}

// -- AVIF -- //

type Box = { type: string; start: number; end: number };

/** One ISO box at an offset inside a parent that ends at limit, or null when it does not fit. */
function readBox(b: Uint8Array, at: number, limit: number): Box | null {
	if (at + 8 > limit || at + 8 > b.byteLength) return null;
	let size = u32be(b, at);
	let head = 8;
	if (size === 1) {
		if (at + 16 > limit || u32be(b, at + 8) !== 0) return null;
		size = u32be(b, at + 12);
		head = 16;
	} else if (size === 0) size = limit - at;
	if (size < head || at + size > limit || at + size > b.byteLength) return null;
	return { type: ascii(b, at + 4, 4), start: at + head, end: at + size };
}

function children(b: Uint8Array, from: number, to: number): Box[] {
	const out: Box[] = [];
	let at = from;
	for (let n = 0; n < MAX_STEPS && at < to; n++) {
		const box = readBox(b, at, to);
		if (!box) break;
		out.push(box);
		at = box.end;
	}
	return out;
}

/** AVIF needs the brand avif or avis as the major or a compatible brand; heic, heix and mif1 alone are refused. */
function avifBrand(b: Uint8Array): boolean {
	const box = readBox(b, 0, b.byteLength);
	if (!box || box.type !== 'ftyp' || box.end - box.start < 8) return false;
	const brands = [ascii(b, box.start, 4)];
	for (let at = box.start + 8, n = 0; at + 4 <= box.end && n < MAX_STEPS; at += 4, n++)
		brands.push(ascii(b, at, 4));
	return brands.some((x) => x === 'avif' || x === 'avis');
}

/** The ispe width of the primary item: pitm names it, ipma links it to property numbers, ipco holds the properties. */
function avifWidth(b: Uint8Array): number | null {
	const top = children(b, 0, b.byteLength);
	const meta = top.find((x) => x.type === 'meta');
	// meta is a full box: four bytes of version and flags come before its children
	if (!meta || meta.start + 4 > meta.end) return null;
	const inner = children(b, meta.start + 4, meta.end);
	const pitm = inner.find((x) => x.type === 'pitm');
	const iprp = inner.find((x) => x.type === 'iprp');
	if (!pitm || !iprp) return null;
	const pv = b[pitm.start];
	if (pitm.start + (pv === 0 ? 6 : 8) > pitm.end) return null;
	const primary = pv === 0 ? u16be(b, pitm.start + 4) : u32be(b, pitm.start + 4);
	const props = children(b, iprp.start, iprp.end);
	const ipco = props.find((x) => x.type === 'ipco');
	if (!ipco) return null;
	const list = children(b, ipco.start, ipco.end);
	// More than one ipma box is allowed: the primary item may be linked in any of them. Property numbers count from 1
	for (const ipma of props.filter((x) => x.type === 'ipma')) {
		for (const index of associations(b, ipma, primary) ?? []) {
			const prop = list[index - 1];
			if (prop?.type === 'ispe' && prop.start + 12 <= prop.end) return u32be(b, prop.start + 4);
		}
	}
	return null;
}

/** The property numbers the ipma box gives one item, or null when the box is cut short. */
function associations(b: Uint8Array, ipma: Box, itemId: number): number[] | null {
	const version = b[ipma.start];
	const wide = ((b[ipma.start + 1] << 16) | (b[ipma.start + 2] << 8) | b[ipma.start + 3]) & 1;
	let at = ipma.start + 4;
	if (at + 4 > ipma.end) return null;
	const count = u32be(b, at);
	at += 4;
	for (let n = 0; n < Math.min(count, MAX_STEPS * 16); n++) {
		const idSize = version < 1 ? 2 : 4;
		if (at + idSize + 1 > ipma.end) return null;
		const id = idSize === 2 ? u16be(b, at) : u32be(b, at);
		const links = b[at + idSize];
		at += idSize + 1;
		const step = wide ? 2 : 1;
		if (at + links * step > ipma.end) return null;
		if (id === itemId) {
			const out: number[] = [];
			for (let k = 0; k < links; k++) {
				const v = wide ? u16be(b, at + k * 2) & 0x7fff : b[at + k] & 0x7f;
				out.push(v);
			}
			return out;
		}
		at += links * step;
	}
	return null;
}
