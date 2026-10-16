// MARKDOWN RENDERING WITH NO RAW HTML (L10). RAW HTML IN THE TEXT IS SHOWN AS TEXT, NEVER RUN.
// Links keep only safe schemes, images keep only http, https and relative sources, and text written by a guest
// (untrusted) gets no images at all, so it cannot load a tracking pixel from another site.

// -- DEP-MODULES -- //
import MarkdownIt from 'markdown-it';

// -- CONSTANTS -- //

/** The longest text rendered in one go. Longer text is cut with a note, so one document cannot stall a page. */
export const MAX_RENDER_CHARS = 500_000;
const SAFE_LINK = /^(?:https?:|mailto:|\/(?!\/)|#)/i;
const SAFE_IMAGE = /^(?:https?:|\/(?!\/))/i;
const CACHE_LIMIT = 500;
/** The most characters of text the cache keeps in all. */
const CACHE_CHARS = 20_000_000;

// -- STATES -- //

const cache = new Map<string, string>();
let cacheChars = 0;

// -- FUNCTIONS -- //

function build(untrusted: boolean): InstanceType<typeof MarkdownIt> {
	const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
	md.validateLink = (url) => SAFE_LINK.test(url.trim());
	const linkOpen =
		md.renderer.rules.link_open ??
		((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
	md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
		const t = tokens[idx];
		const href = String(t.attrGet('href') ?? '');
		if (/^https?:/i.test(href)) {
			t.attrSet('target', '_blank');
			t.attrSet(
				'rel',
				untrusted ? 'noopener noreferrer nofollow ugc' : 'noopener noreferrer nofollow'
			);
		}
		return linkOpen(tokens, idx, options, env, self);
	};
	md.renderer.rules.image = (tokens, idx) => {
		const t = tokens[idx];
		const src = String(t.attrGet('src') ?? '');
		const alt = md.utils.escapeHtml(t.content);
		// Untrusted text shows the picture as a plain label, and an unsafe source never becomes an image
		if (untrusted || !SAFE_IMAGE.test(src.trim()))
			return `<span>[image${alt ? `: ${alt}` : ''}]</span>`;
		return `<img src="${md.utils.escapeHtml(src)}" alt="${alt}" loading="lazy" decoding="async">`;
	};
	return md;
}

const trusted = build(false);
const guest = build(true);

/** Renders Markdown to safe HTML. */
export function renderMarkdown(text: string, options: { untrusted?: boolean } = {}): string {
	const cut =
		text.length > MAX_RENDER_CHARS
			? `${text.slice(0, MAX_RENDER_CHARS)}\n\n_The rest of this text is not shown._`
			: text;
	return (options.untrusted ? guest : trusted).render(cut);
}

/** The same, remembered by content, so a document that did not change is not rendered again (SPEC 12). */
export function renderMarkdownCached(text: string, options: { untrusted?: boolean } = {}): string {
	// The key is the text itself, never a hash of it: a hash that two different texts share would hand one person's page
	// to another, and a cache shared by every organisation on the server must not allow that.
	const key = `${options.untrusted ? 'u' : 't'}:${text}`;
	const hit = cache.get(key);
	if (hit !== undefined) return hit;
	const html = renderMarkdown(text, options);
	// Kept within a total size as well as a count, so a few huge documents cannot fill the memory
	while (cache.size && (cache.size >= CACHE_LIMIT || cacheChars + key.length > CACHE_CHARS)) {
		const oldest = cache.keys().next().value as string;
		cacheChars -= oldest.length;
		cache.delete(oldest);
	}
	if (key.length <= CACHE_CHARS / 4) {
		cache.set(key, html);
		cacheChars += key.length;
	}
	return html;
}
