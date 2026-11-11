// WHICH TEXT THE EDITOR HOLDS (AFB-20261111-0035, STEP 4.3)
// The editor's text lives apart from the page data. The page data is read again whenever anything on the project changes
// (invalidate afb:project), and that must never rewrite what a person is typing. An editing session is named by the note and
// its epoch: the same name means the same live document, so a refresh changes nothing. A new epoch means the text was replaced
// from outside (an agent, a restore), so a new session opens on the new text.

// -- TYPES -- //

export interface NoteSnapshot {
	noteId: string;
	epoch: number;
	version: number;
	title: string;
	markdown: string;
}

export interface Session {
	key: string;
	snapshot: NoteSnapshot;
}

export type SessionStep = { kind: 'keep'; session: Session } | { kind: 'open'; session: Session };

// -- FUNCTIONS -- //

/**
 * What the page opens a live session on. Only a person who can write gets one: a reader, a note that is gone and a note
 * the person may not see yield null, so no provider is ever created for them (a reader sees the rendered text and nothing live).
 */
export function liveSnapshot(
	note: (Pick<NoteSnapshot, 'epoch' | 'version' | 'title'> & { id: string }) | null | undefined,
	canWrite: boolean,
	markdown: string
): NoteSnapshot | null {
	if (!note || !canWrite) return null;
	return {
		noteId: note.id,
		epoch: note.epoch,
		version: note.version,
		title: note.title,
		markdown
	};
}

export const sessionKey = (s: Pick<NoteSnapshot, 'noteId' | 'epoch'>) => `${s.noteId}:${s.epoch}`;

/**
 * What to do with fresh page data. The same note and epoch keeps the session exactly as it is (its text, its version, its
 * saver); anything else opens a new one from the new data.
 */
export function nextSession(
	current: Session | null,
	incoming: NoteSnapshot | null
): SessionStep | null {
	if (!incoming) return null;
	const key = sessionKey(incoming);
	if (current && current.key === key) return { kind: 'keep', session: current };
	return { kind: 'open', session: { key, snapshot: incoming } };
}
