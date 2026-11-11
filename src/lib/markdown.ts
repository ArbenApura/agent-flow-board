// MARKDOWN RENDERING WITH NO RAW HTML (L10). RAW HTML IN THE TEXT IS SHOWN AS TEXT, NEVER RUN.
// Links keep only safe schemes, images keep only http, https and relative sources, and text written by a guest
// (untrusted) gets no images at all, so it cannot load a tracking pixel from another site.
// With a link base (the org and project the text lives in) the renderer also turns afb: links and bare references into
// board addresses. It is still a pure function: it looks nothing up, it shows the reference as written (AFB-20261111-0035).

// -- TYPES -- //
import type { Token } from 'markdown-it';
// -- DEP-MODULES -- //
import MarkdownIt from 'markdown-it';
// -- MODULES -- //
import { noteFileUrl } from './shared/notes';

// -- TYPES -- //

/** Where a text lives, so its board links can be addresses. Slugs and keys as they appear in the board's own addresses. */
export type LinkBase = { org: string; project: string };
export type RenderOptions = {
	untrusted?: boolean;
	linkBase?: LinkBase;
	/** A note: pictures only from afb:file (any other picture address becomes a plain link) and checklists with tick boxes. */
	mode?: 'note';
};

// -- CONSTANTS -- //

/** The longest text rendered in one go. Longer text is cut with a note, so one document cannot stall a page. */
export const MAX_RENDER_CHARS = 500_000;
const SAFE_LINK = /^(?:https?:|mailto:|\/(?!\/)|#)/i;
const SAFE_IMAGE = /^(?:https?:|\/(?!\/))/i;
const CACHE_LIMIT = 500;
/** The most characters of text the cache keeps in all. */
const CACHE_CHARS = 20_000_000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** The only afb: forms there are. Each kind has its own id shape, so nothing else can ride along in an address. */
const AFB_LINK = new RegExp(
	`^afb:(?:(note)/(N-[1-9][0-9]{0,8}|${UUID})|(task)/(T-[1-9][0-9]{0,8}|${UUID})|(item)/([A-Za-z0-9][A-Za-z0-9-]{0,40})|(mockup)/(${UUID})|(file)/(${UUID}))$`,
	'i'
);
/**
 * A bare reference in running text: N-12, T-12 or a plan reference such as AFB-20261107-0346. Bounded on both sides so it
 * never matches inside a longer word, number or address, and every quantifier is bounded so it cannot run away.
 */
export const BARE_REF =
	/(?<![A-Za-z0-9_\-/.@#:])(?:N-[1-9][0-9]{0,8}|T-[1-9][0-9]{0,8}|[A-Z][A-Z0-9]{1,9}-[0-9]{8}-[0-9]{4}(?:-[a-z])?)(?![A-Za-z0-9_-])/g;
const CHECKBOX = /^\[([ xX])\](?=\s|$)\s?/;

const cache = new Map<string, string>();
let cacheChars = 0;

// -- FUNCTIONS -- //

/** The kind and id an afb: address names, or null when it is not exactly one of the allowed forms. */
export function parseAfbLink(href: string): { kind: string; id: string } | null {
	const m = AFB_LINK.exec(href.trim());
	if (!m) return null;
	for (let i = 1; i < m.length; i += 2) if (m[i]) return { kind: m[i].toLowerCase(), id: m[i + 1] };
	return null;
}

/** The board address of an afb: target inside one project. Nothing is looked up: the id is used as written. */
function addressOf(base: LinkBase, kind: string, id: string): string {
	const root = `/${encodeURIComponent(base.org)}/${encodeURIComponent(base.project)}`;
	const seg = encodeURIComponent(id);
	if (kind === 'note') return `${root}/notes/${seg}`;
	if (kind === 'task') return `${root}/tasks?task=${seg}`;
	if (kind === 'mockup') return `${root}/mockups/${seg}`;
	if (kind === 'file') return noteFileUrl(base.org, id);
	return `${root}/${seg}`;
}

/** The address a bare reference points at: N-12 a note, T-12 a task, anything else a plan. */
function bareAddress(base: LinkBase, ref: string): string {
	if (ref.startsWith('N-')) return addressOf(base, 'note', ref);
	if (ref.startsWith('T-')) return addressOf(base, 'task', ref);
	return addressOf(base, 'item', ref);
}

function build(
	untrusted: boolean,
	note: boolean,
	boards: boolean
): InstanceType<typeof MarkdownIt> {
	const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
	md.validateLink = (url) => SAFE_LINK.test(url.trim()) || (boards && parseAfbLink(url) !== null);
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
		const tag = `<img src="${md.utils.escapeHtml(src)}" alt="${alt}" loading="lazy" decoding="async">`;
		// A picture of the board itself (set by the afb rule from an afb:file address, never from the text's own address)
		if (t.meta?.afbFile) return tag;
		const label = `<span>[image${alt ? `: ${alt}` : ''}]</span>`;
		if (note) {
			// A note shows pictures from afb:file only: another address is a plain link the reader chooses to follow
			const href = src.trim();
			if (!/^https?:/i.test(href)) return label;
			return `<a href="${md.utils.escapeHtml(href)}" target="_blank" rel="noopener noreferrer nofollow ugc">${alt || md.utils.escapeHtml(href)}</a>`;
		}
		// Untrusted text shows the picture as a plain label, and an unsafe source never becomes an image
		if (untrusted || !SAFE_IMAGE.test(src.trim())) return label;
		return tag;
	};
	// -- BOARD LINKS, BARE REFERENCES AND CHECKLISTS -- //
	if (boards || note) {
		md.core.ruler.push('afb', (state) => {
			const base = (state.env as { linkBase?: LinkBase }).linkBase;
			for (let b = 0; b < state.tokens.length; b++) {
				const block = state.tokens[b];
				if (note && block.type === 'list_item_open') tickBox(state.tokens, b, state.Token);
				if (block.type !== 'inline' || !block.children || !base) continue;
				const out: Token[] = [];
				let inLink = 0;
				for (const child of block.children) {
					if (child.type === 'link_open') {
						inLink++;
						const hit = parseAfbLink(String(child.attrGet('href') ?? ''));
						if (hit) child.attrSet('href', addressOf(base, hit.kind, hit.id));
					} else if (child.type === 'link_close') {
						inLink = Math.max(0, inLink - 1);
					} else if (child.type === 'image') {
						const hit = parseAfbLink(String(child.attrGet('src') ?? ''));
						if (hit) {
							child.attrSet('src', addressOf(base, hit.kind, hit.id));
							if (hit.kind === 'file') child.meta = { afbFile: true };
						}
					} else if (child.type === 'text' && !inLink && child.content.length >= 3) {
						linkRefs(child, base, out, state.Token);
						continue;
					}
					out.push(child);
				}
				block.children = out;
			}
			return true;
		});
	}
	return md;
}

/** Splits one text token around the bare references in it. The references are shown as written. */
function linkRefs(
	child: Token,
	base: LinkBase,
	out: Token[],
	TokenClass: new (type: string, tag: string, nesting: 0 | 1 | -1) => Token
) {
	const text = child.content;
	BARE_REF.lastIndex = 0;
	let at = 0;
	let m: RegExpExecArray | null;
	let any = false;
	while ((m = BARE_REF.exec(text))) {
		any = true;
		if (m.index > at) {
			const t = new TokenClass('text', '', 0);
			t.content = text.slice(at, m.index);
			out.push(t);
		}
		const open = new TokenClass('link_open', 'a', 1);
		open.attrs = [['href', bareAddress(base, m[0])]];
		open.markup = 'afb-ref';
		const label = new TokenClass('text', '', 0);
		label.content = m[0];
		out.push(open, label, new TokenClass('link_close', 'a', -1));
		at = m.index + m[0].length;
	}
	if (!any) {
		out.push(child);
		return;
	}
	if (at < text.length) {
		const t = new TokenClass('text', '', 0);
		t.content = text.slice(at);
		out.push(t);
	}
}

/** A list item that starts with [ ] or [x] gets a disabled tick box in place of the brackets. */
function tickBox(
	tokens: Token[],
	open: number,
	TokenClass: new (type: string, tag: string, nesting: 0 | 1 | -1) => Token
) {
	const inline = tokens[open + 2];
	if (!inline || inline.type !== 'inline' || !inline.children?.length) return;
	const first = inline.children[0];
	if (first.type !== 'text') return;
	const m = CHECKBOX.exec(first.content);
	if (!m) return;
	first.content = first.content.slice(m[0].length);
	const box = new TokenClass('html_inline', '', 0);
	const done = m[1] !== ' ';
	box.content = `<input type="checkbox" disabled${done ? ' checked' : ''}> `;
	inline.children.unshift(box);
	tokens[open].attrJoin('class', 'task-list-item');
}

// One renderer per combination, built when first used
const parsers = new Map<string, InstanceType<typeof MarkdownIt>>();
function parser(untrusted: boolean, note: boolean, boards: boolean) {
	const key = `${untrusted ? 'u' : 't'}${note ? 'n' : 'p'}${boards ? 'b' : 'x'}`;
	let md = parsers.get(key);
	if (!md) {
		md = build(untrusted, note, boards);
		parsers.set(key, md);
	}
	return md;
}

/** Renders Markdown to safe HTML. */
export function renderMarkdown(text: string, options: RenderOptions = {}): string {
	const cut =
		text.length > MAX_RENDER_CHARS
			? `${text.slice(0, MAX_RENDER_CHARS)}\n\n_The rest of this text is not shown._`
			: text;
	const md = parser(!!options.untrusted, options.mode === 'note', !!options.linkBase);
	return md.render(cut, { linkBase: options.linkBase });
}

/** The same, remembered by content, so a document that did not change is not rendered again (SPEC 12). */
export function renderMarkdownCached(text: string, options: RenderOptions = {}): string {
	// The key is the text itself, never a hash of it: a hash that two different texts share would hand one person's page
	// to another, and a cache shared by every organisation on the server must not allow that. The link base and the mode
	// are part of it, so the same words in two projects keep their own addresses. NUL cannot occur in a slug or a key.
	const b = options.linkBase;
	const key = `${options.untrusted ? 'u' : 't'}${options.mode === 'note' ? 'n' : 'p'}\0${b ? `${b.org}\0${b.project}` : ''}\0${text}`;
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
