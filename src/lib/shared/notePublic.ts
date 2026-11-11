// THE READ VIEW OF A PUBLIC NOTE: BOARD ADDRESSES OUT, PICTURES SERVED UNDER THE SAME ADDRESS (AFB-20261111-0035, 7.2)
// The note is rendered with a placeholder link base, so every board address in the result starts with the placeholder. A reader
// of a public link has no board: links to plans, tasks and notes become plain text, and a picture is read from /n/<address>/file/.

// -- CONSTANTS -- //

/** The placeholder org and project the renderer is given for a public note. Slugs are never this short, so it cannot clash. */
export const PUBLIC_LINK_BASE = { org: '_', project: '_' } as const;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** An anchor that points at the board (a page of the placeholder org, or a picture address used as a link). */
const BOARD_ANCHOR =
	/<a\s[^>]*href="(?:\/_\/_\/|\/api\/v1\/orgs\/_\/)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
const PICTURE_SRC = new RegExp(`src="/api/v1/orgs/_/notes/files/(${UUID})"`, 'gi');
const TOKEN = /^[A-Za-z0-9_-]{20,128}$/;

// -- FUNCTIONS -- //

/**
 * Turns the HTML renderMarkdown made with PUBLIC_LINK_BASE into the HTML of a public page. Anchors to the board lose their
 * link and keep their text, and every board picture is read under the address. A token that is not an address gives no
 * pictures at all.
 */
export function publicNoteHtml(html: string, token: string): string {
	const plain = html.replace(BOARD_ANCHOR, '$1');
	if (!TOKEN.test(token)) return plain.replace(PICTURE_SRC, 'src=""');
	return plain.replace(PICTURE_SRC, (_all, id: string) => `src="/n/${token}/file/${id}"`);
}
