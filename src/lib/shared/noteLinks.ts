// NOTE TEXT LINKS: THE REFERENCES A NOTE BODY NAMES, FOUND WITHOUT LOOKING ANYTHING UP (AFB-20261111-0035, rule 8)
// A pure function. The matchers are the renderer's own (parseAfbLink and BARE_REF in markdown.ts), so what the screen draws
// as a link and what the server stores as a link are the same set. Code spans and fenced blocks name nothing.

// IMPORTED MODULES
import { BARE_REF, parseAfbLink } from '../markdown';

// -- TYPES -- //

export type NoteRefKind = 'item' | 'task' | 'mockup' | 'note';
/** One thing a body names, as written: a reference (N-12, T-4, AFB-20261107-0346) or an id. */
export type NoteRef = { kind: NoteRefKind; ref: string };

// -- CONSTANTS -- //

/** The most distinct references one body is worked out for, so a huge body cannot make a huge lookup. */
export const MAX_TEXT_LINKS = 200;
const AFB_ADDRESS = /afb:(?:note|task|item|mockup)\/[A-Za-z0-9][A-Za-z0-9-]*/gi;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// -- FUNCTIONS -- //

/** The text with fenced blocks and inline code spans cut out. */
export function withoutCode(text: string): string {
	const kept: string[] = [];
	let open: { char: string; size: number } | null = null;
	for (const line of text.split('\n')) {
		const m = FENCE.exec(line);
		if (open) {
			// A closing fence uses the same character, at least as long, and has nothing after it
			if (m && m[1][0] === open.char && m[1].length >= open.size && line.trim() === m[1])
				open = null;
			continue;
		}
		if (m) {
			open = { char: m[1][0], size: m[1].length };
			continue;
		}
		kept.push(line);
	}
	// A code span opens with a run of backticks and ends at the next run of the same length
	return kept.join('\n').replace(/(`+)[\s\S]*?\1(?!`)/g, ' ');
}

/** The distinct references a body names: afb: addresses first, then bare references. At most MAX_TEXT_LINKS. */
export function extractNoteRefs(body: string): NoteRef[] {
	const text = withoutCode(body);
	const seen = new Set<string>();
	const out: NoteRef[] = [];
	const add = (kind: NoteRefKind, ref: string) => {
		const key = `${kind}:${ref.toUpperCase()}`;
		if (seen.has(key) || out.length >= MAX_TEXT_LINKS) return;
		seen.add(key);
		out.push({ kind, ref });
	};
	for (const m of text.matchAll(AFB_ADDRESS)) {
		const hit = parseAfbLink(m[0]);
		if (hit) add(hit.kind as NoteRefKind, hit.id);
	}
	// The afb: addresses are taken out so the plan reference inside one is not read a second time as a bare one
	const bare = text.replace(AFB_ADDRESS, ' ');
	for (const m of bare.matchAll(new RegExp(BARE_REF.source, 'g'))) {
		const ref = m[0];
		add(ref.startsWith('N-') ? 'note' : ref.startsWith('T-') ? 'task' : 'item', ref);
	}
	return out;
}
