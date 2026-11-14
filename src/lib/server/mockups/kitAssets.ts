// KIT ASSET EXTRACTION AND PLACEHOLDER MATERIALIZATION (STEP B.3, AFB-20261113-1008)
// Splits large kit stylesheets and embedded base64 font/image files out of the kit head into stored files
// so served mockup pages carry lightweight <link> tags instead of multi-megabyte inline CSS/font blobs.

// IMPORTED DEP-MODULES
import { createHash } from 'node:crypto';
// IMPORTED MODULES
import { kitHeadOf } from './kitHead';

// -- TYPES -- //

export type ExtractedKitAsset = {
	name: string;
	mime: string;
	ext: string;
	bytes: Uint8Array;
	size: number;
	checksum: string;
};

export type ExtractedKit = {
	/** Replaced kit head carrying {{AFB_ASSET:<name>}} links, or null if left inline. */
	headTemplate: string | null;
	assets: ExtractedKitAsset[];
};

// -- CONSTANTS -- //

const INLINE_CSS_THRESHOLD = 16_384;
const INLINE_DATA_THRESHOLD = 1_024;
const MAX_KIT_ASSETS = 64;
const SAFE_DATA_MIMES: Record<string, { ext: string; mime: string }> = {
	'font/woff2': { ext: 'woff2', mime: 'font/woff2' },
	'application/font-woff2': { ext: 'woff2', mime: 'font/woff2' },
	'font/woff': { ext: 'woff', mime: 'font/woff' },
	'application/font-woff': { ext: 'woff', mime: 'font/woff' },
	'font/ttf': { ext: 'ttf', mime: 'font/ttf' },
	'application/x-font-ttf': { ext: 'ttf', mime: 'font/ttf' },
	'application/font-sfnt': { ext: 'ttf', mime: 'font/ttf' },
	'font/otf': { ext: 'otf', mime: 'font/otf' },
	'application/x-font-otf': { ext: 'otf', mime: 'font/otf' },
	'image/png': { ext: 'png', mime: 'image/png' },
	'image/jpeg': { ext: 'jpg', mime: 'image/jpeg' },
	'image/jpg': { ext: 'jpg', mime: 'image/jpeg' },
	'image/webp': { ext: 'webp', mime: 'image/webp' },
	'image/gif': { ext: 'gif', mime: 'image/gif' },
	'image/svg+xml': { ext: 'svg', mime: 'image/svg+xml' }
};
const STYLE_TAG = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
const CSS_DATA_URI =
	/url\(\s*(["']?)data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[^;,)'"\s]*)*;base64,([A-Za-z0-9+/=\s]+)\1\s*\)/gi;
const ASSET_TOKEN = /\{\{AFB_ASSET:([a-z0-9][a-z0-9._-]{0,60})\}\}/g;

export const KIT_ASSET_NAME =
	/^[a-z0-9][a-z0-9._-]{0,60}\.(css|woff2|woff|ttf|otf|png|jpg|webp|gif|svg)$/i;

// -- FUNCTIONS -- //

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const hasExternalizableDataUri = (css: string): boolean => {
	CSS_DATA_URI.lastIndex = 0;
	for (const match of css.matchAll(CSS_DATA_URI)) {
		const mime = match[2].toLowerCase();
		if (SAFE_DATA_MIMES[mime] && match[3].length >= INLINE_DATA_THRESHOLD) return true;
	}
	return false;
};

const attrsId = (attrs: string): string | null => {
	const match = /\bid\s*=\s*(?:"([^"<>]{1,64})"|'([^'<>]{1,64})')/i.exec(attrs);
	return match?.[1] ?? match?.[2] ?? null;
};

/**
 * Extracts CSS styles and embedded base64 font/image files from a kit head when the head exceeds the small inline
 * threshold or embeds data URI assets. Small literal inline heads (< 16 KB without large data URIs) stay inline.
 */
export function extractKitAssets(kitHtml: string): ExtractedKit {
	const head = kitHeadOf(kitHtml);
	if (!head) return { headTemplate: null, assets: [] };
	let totalCssBytes = 0;
	let anyLargeDataUri = false;
	STYLE_TAG.lastIndex = 0;
	for (const match of head.matchAll(STYLE_TAG)) {
		const body = match[2] ?? '';
		totalCssBytes += Buffer.byteLength(body, 'utf8');
		if (!anyLargeDataUri && hasExternalizableDataUri(body)) anyLargeDataUri = true;
	}
	if (totalCssBytes <= INLINE_CSS_THRESHOLD && !anyLargeDataUri) {
		return { headTemplate: null, assets: [] };
	}

	const assets: ExtractedKitAsset[] = [];
	const byHash = new Map<string, string>();
	let cssIndex = 0;
	let assetIndex = 0;

	const registerAsset = (
		name: string,
		mime: string,
		ext: string,
		bytes: Uint8Array
	): string | null => {
		if (assets.length >= MAX_KIT_ASSETS) return null;
		const checksum = sha256(bytes);
		const existing = byHash.get(`${mime}:${checksum}`);
		if (existing) return existing;
		assets.push({ name, mime, ext, bytes, size: bytes.byteLength, checksum });
		byHash.set(`${mime}:${checksum}`, name);
		return name;
	};

	STYLE_TAG.lastIndex = 0;
	const headTemplate = head.replace(STYLE_TAG, (full, attrs: string, cssBody: string) => {
		if (Buffer.byteLength(cssBody, 'utf8') <= 1_024 && !hasExternalizableDataUri(cssBody)) {
			return full;
		}
		CSS_DATA_URI.lastIndex = 0;
		const rewrittenCss = cssBody.replace(
			CSS_DATA_URI,
			(orig, _q: string, rawMime: string, rawB64: string) => {
				const spec = SAFE_DATA_MIMES[rawMime.toLowerCase()];
				if (!spec) return orig;
				const cleanB64 = rawB64.replace(/\s+/g, '');
				if (!cleanB64) return orig;
				const bytes = Uint8Array.from(Buffer.from(cleanB64, 'base64'));
				if (bytes.byteLength === 0) return orig;
				const candidate = `asset-${assetIndex++}.${spec.ext}`;
				const stored = registerAsset(candidate, spec.mime, spec.ext, bytes);
				if (!stored) return orig;
				return `url("{{AFB_ASSET:${stored}}}")`;
			}
		);
		const cssBytes = new TextEncoder().encode(rewrittenCss);
		const cssName = `kit-${cssIndex++}.css`;
		const storedCss = registerAsset(cssName, 'text/css; charset=utf-8', 'css', cssBytes);
		if (!storedCss) return full;
		const id = attrsId(attrs ?? '');
		const idAttr = id ? ` id="${id.replace(/"/g, '')}"` : '';
		return `<link rel="stylesheet"${idAttr} href="{{AFB_ASSET:${storedCss}}}">`;
	});

	if (assets.length === 0) return { headTemplate: null, assets: [] };
	return { headTemplate, assets };
}

/** True when a head template uses external asset tokens. */
export const hasAssetPlaceholders = (text: string): boolean => text.includes('{{AFB_ASSET:');

/** Replaces every {{AFB_ASSET:name}} placeholder using the caller's URL builder. */
export function materializeAssetPlaceholders(
	text: string,
	urlFor: (assetName: string) => string | null
): string {
	ASSET_TOKEN.lastIndex = 0;
	return text.replace(ASSET_TOKEN, (_m, name: string) => urlFor(name) ?? '');
}
