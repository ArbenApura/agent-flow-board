// NOTE EXCERPTS: THE PLAIN TEXT A LIST ROW OR A CARD SHOWS FOR A NOTE, AND THE WINDOW AROUND A SEARCH HIT (AFB-20261111-0805)
// A row never renders a note as HTML: the excerpt is plain text, and the matched words travel as character ranges.

// -- CONSTANTS -- //

/** Characters of an excerpt, cut on a word edge. */
export const EXCERPT_CHARS = 240;
/** Characters of the note text the server reads to build one. */
export const EXCERPT_SOURCE_CHARS = 1500;

// -- TYPES -- //

/** A search excerpt: the text and the [start, end) ranges of the words that matched. */
export type NoteMatch = { text: string; marks: [number, number][] };

// -- FUNCTIONS -- //

/**
 * Markdown as one line of plain text: no markup, no table rules, no picture addresses, single spaces. Every pattern
 * stays on one line and has a bounded length, so a 200,000 character note with stray brackets or blank lines stays linear.
 */
export function plainText(md: string): string {
	return (
		md
			.replace(/\r\n?/g, '\n')
			// Fenced code keeps its text, the fences go
			.replace(/^[ \t]*(```|~~~)[^\n]*$/gm, ' ')
			// Pictures go, links keep their words
			.replace(/!\[[^\]\n]{0,300}\]\([^)\n]{0,500}\)/g, ' ')
			.replace(/\[([^\]\n]{0,300})\]\([^)\n]{0,500}\)/g, '$1')
			// Table rules (|---|:--:|) go, cell bars become spaces
			.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
			.replace(/\|/g, ' ')
			// Headings, quotes, list markers and checkboxes at the start of a line
			.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
			.replace(/^[ \t]*>[ \t]?/gm, '')
			.replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
			// A line of dashes or stars is a divider
			.replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, ' ')
			// Emphasis, code and strike marks
			.replace(/(\*\*|__|~~)([^\n]{1,300}?)\1/g, '$2')
			.replace(/(^|[\s(])[*_]([^*_\n]{1,300})[*_](?=[\s).,;:!?]|$)/g, '$1$2')
			.replace(/`([^`\n]{0,300})`/g, '$1')
			.replace(/<\/?[A-Za-z][^>\n]{0,200}>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

/** Cuts text to at most `max` characters on a word edge, with an ellipsis when it was cut. */
function cut(text: string, max: number): string {
	if (text.length <= max) return text;
	const part = text.slice(0, max);
	const space = part.lastIndexOf(' ');
	return `${(space > max * 0.6 ? part.slice(0, space) : part).replace(/[\s,.;:]+$/, '')}…`;
}

/**
 * The excerpt of a note for its row and card: plain text, with a first heading that only repeats the title left out.
 */
export function noteExcerpt(title: string, md: string, max = EXCERPT_CHARS): string {
	let body = md.replace(/\r\n?/g, '\n').replace(/^\s+/, '');
	const first = body.match(/^#{1,6}\s+(.*)\n?/);
	if (first && first[1].trim().toLowerCase() === title.trim().toLowerCase())
		body = body.slice(first[0].length);
	return cut(plainText(body), max);
}

/** The words of a search, lower case, longest first so a longer word is marked before a shorter one inside it. */
function wordsOf(q: string): string[] {
	return [
		...new Set(
			q
				.toLowerCase()
				.split(/\s+/)
				.filter((w) => w.length > 0)
		)
	].sort((a, b) => b.length - a.length);
}

/**
 * The excerpt around the first place the search matches, with every match inside it as a range. Null when the text
 * does not hold the words (the note matched on its title only).
 */
export function noteMatch(md: string, q: string, max = EXCERPT_CHARS): NoteMatch | null {
	const words = wordsOf(q);
	if (!words.length) return null;
	const text = plainText(md);
	// Case-blind searches on the text itself, so the offsets never drift when lower case changes a string's length
	const find = (w: string, from = 0) => {
		const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
		re.lastIndex = from;
		const m = re.exec(text);
		return m ? { at: m.index, len: m[0].length } : null;
	};
	// The window follows the longest word that is there, the one least likely to be a common word
	const anchor = words.map((w) => find(w)).find((h) => h !== null);
	if (!anchor) return null;
	const first = anchor.at;
	// The window starts a little before the hit, on a word edge, so the hit reads in its sentence
	let start = Math.max(0, first - Math.floor(max / 4));
	if (start > 0) {
		const space = text.indexOf(' ', start);
		start = space >= 0 && space < first ? space + 1 : start;
	}
	let end = Math.min(text.length, start + max);
	if (end < text.length) {
		const space = text.lastIndexOf(' ', end);
		end = space > first ? space : end;
	}
	// The window always holds the whole word it was built around
	end = Math.max(end, Math.min(text.length, first + anchor.len));
	const lead = start > 0 ? '…' : '';
	const tail = end < text.length ? '…' : '';
	const out = `${lead}${text.slice(start, end)}${tail}`;
	const marks: [number, number][] = [];
	for (const w of words)
		for (
			let hit = find(w, start);
			hit && hit.at + hit.len <= end;
			hit = find(w, hit.at + hit.len)
		) {
			const a = hit.at - start + lead.length;
			const b = a + hit.len;
			if (!marks.some(([x, y]) => a < y && b > x)) marks.push([a, b]);
		}
	marks.sort((x, y) => x[0] - y[0]);
	return { text: out, marks };
}
