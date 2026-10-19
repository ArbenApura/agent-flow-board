// THE STANDARD STREAMS AND SCOPES A NEW PROJECT STARTS WITH, AND THE RULES A LIST OF THEM MUST KEEP (SHARED BY OPS AND THE SETTINGS TAB)

// -- TYPES -- //
export type StreamList = { stream: string; scopes: string[] }[];
/** A row in the settings editor: the same as a stream, with an id that exists only in the browser so each row keeps its own inputs. */
export type StreamRow = StreamList[number] & { id: string };

// -- CONSTANTS -- //

export const MAX_STREAMS = 20;
export const MAX_SCOPES = 20;
export const MAX_NAME = 40;

/** The set a new project starts with, taken from the HAPR gameplan board: what kind of work, and which part it touches. */
export const STANDARD_STREAMS: StreamList = [
	{ stream: 'features', scopes: ['core', 'routes', 'components'] },
	{ stream: 'refactors', scopes: ['core', 'routes', 'components'] },
	{ stream: 'fixes', scopes: ['critical', 'routine'] },
	{ stream: 'investigations', scopes: ['integrations', 'schemas'] }
];

// -- FUNCTIONS -- //

/** A fresh copy of the standard set, so nobody mutates the shared one. */
export const standardStreams = (): StreamList =>
	STANDARD_STREAMS.map((s) => ({ stream: s.stream, scopes: [...s.scopes] }));

let rowCount = 0;

/** Gives every stream its own browser-only id, and copies the scopes so editing a row never changes the saved list. */
export const withIds = (list: StreamList): StreamRow[] =>
	list.map((s) => ({ id: `row-${++rowCount}`, stream: s.stream, scopes: [...s.scopes] }));

/** The list as it is saved: no ids, and no copies of the editor's arrays. */
export const withoutIds = (rows: StreamRow[]): StreamList =>
	rows.map((r) => ({ stream: r.stream, scopes: [...r.scopes] }));

/** What is saved from the editor: no ids, names without spaces at the ends, and no row without a stream name. */
export const savedStreams = (rows: StreamRow[]): StreamList =>
	rows
		.filter((r) => r.stream.trim())
		.map((r) => ({
			stream: r.stream.trim(),
			scopes: r.scopes.map((t) => t.trim()).filter(Boolean)
		}));

/** Names are compared without spaces at the ends and without caring about case. */
export const nameKey = (name: string) => name.trim().toLowerCase();

/** The first plain-words problem in a list of streams, or null when it can be saved. Blank rows are ignored (they are dropped on save). */
export function streamsProblem(list: StreamList): string | null {
	const rows = list.filter((s) => s.stream.trim());
	if (rows.length > MAX_STREAMS) return `A project holds at most ${MAX_STREAMS} streams.`;
	const seen = new Set<string>();
	for (const s of rows) {
		if (s.stream.trim().length > MAX_NAME)
			return `A stream name is at most ${MAX_NAME} characters: ${s.stream.trim().slice(0, 12)}...`;
		const k = nameKey(s.stream);
		if (seen.has(k)) return `The stream ${s.stream.trim()} is listed twice.`;
		seen.add(k);
		if (s.scopes.length > MAX_SCOPES)
			return `${s.stream.trim()} holds at most ${MAX_SCOPES} scopes.`;
		const scopes = new Set<string>();
		for (const sc of s.scopes) {
			if (sc.trim().length > MAX_NAME)
				return `A scope name is at most ${MAX_NAME} characters: ${sc.trim().slice(0, 12)}...`;
			const sk = nameKey(sc);
			if (scopes.has(sk)) return `The scope ${sc.trim()} is listed twice in ${s.stream.trim()}.`;
			scopes.add(sk);
		}
	}
	return null;
}
