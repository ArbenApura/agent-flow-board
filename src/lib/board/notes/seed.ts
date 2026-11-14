// THE FIRST OPEN RULE (AFB-20261111-0035, STEP 4.1)
// A note with Markdown and no live updates yet is turned into a Yjs document by whichever window opens it first. A seed is
// accepted only as update number 1 of the epoch. A window that loses the race drops its own seed and loads the winner's
// updates, so the text exists once. Two seeds of the same text are different Yjs content and would double it if both stayed.

// IMPORTED DEP-MODULES
import * as Y from 'yjs';
// IMPORTED MODULES
import { NOTE_LIMITS } from '../../shared/notes';
import { seedUpdate } from './editorMarkdown.js';

// -- TYPES -- //

/** What the server says about a note's live state. */
export interface LiveSnapshot {
	epoch: number;
	/** The note's Markdown, the base a seed is built from. */
	markdown: string;
	/** The live updates of this epoch, in order. Empty until a first window seeds. */
	updates: Uint8Array[];
	/** The number of the last live update of the epoch (0 when there is none). Left out by a source that does not number them. */
	last?: number;
	/** The number of the last update the stored Markdown covers. */
	checkpointSeq?: number;
}

export type SeedAnswer = { ok: true } | { ok: false; reason: 'taken' | 'epoch' };

export interface SeedApi {
	load: () => Promise<LiveSnapshot>;
	/** Offers a seed as update number 1 of an epoch. Refused when the epoch moved on or the first update is already there. */
	seed: (epoch: number, update: Uint8Array) => Promise<SeedAnswer>;
}

export interface OpenedDocument {
	ydoc: Y.Doc;
	epoch: number;
	/** True when this window built the seed that was kept. */
	seeded: boolean;
	/** The number of the last update this document holds (the seed is number 1). */
	last: number;
	/** The number of the last update the stored Markdown covers, as far as this window knows. */
	checkpointSeq: number;
}

// -- CONSTANTS -- //

/** A lost race or an epoch change repeats the load. A few rounds is plenty; more means something is wrong. */
const MAX_ROUNDS = 6;

// -- FUNCTIONS -- //

/**
 * Opens a note's live document: the winner's updates when there are any, else this window's own seed, offered under the
 * first open rule. Call it again for a new epoch (the text was replaced from outside): the old document is the caller's to destroy.
 */
export async function openDocument(
	api: SeedApi,
	build: (markdown: string) => Uint8Array = seedUpdate
): Promise<OpenedDocument> {
	for (let round = 0; round < MAX_ROUNDS; round++) {
		const snap = await api.load();
		const ydoc = new Y.Doc();
		if (snap.updates.length > 0) {
			for (const u of snap.updates) Y.applyUpdate(ydoc, u);
			return {
				ydoc,
				epoch: snap.epoch,
				seeded: false,
				last: snap.last ?? snap.updates.length,
				checkpointSeq: snap.checkpointSeq ?? 0
			};
		}
		const mine = build(snap.markdown);
		// The first live update is one piece, and the server takes no piece over its limit. Nothing is written, so the stored
		// text is untouched and the note simply is not opened for live editing
		if (mine.byteLength > NOTE_LIMITS.updateBytes) {
			ydoc.destroy();
			throw new Error(
				'This note is too long to open for live editing here. Its text is safe. Shorten it from a smaller edit (for example through the API) or split it into two notes.'
			);
		}
		const answer = await api.seed(snap.epoch, mine);
		if (answer.ok) {
			Y.applyUpdate(ydoc, mine);
			return { ydoc, epoch: snap.epoch, seeded: true, last: 1, checkpointSeq: 0 };
		}
		// Lost the race, or the epoch moved: the seed is dropped and everything is read again
		ydoc.destroy();
	}
	throw new Error('The note could not be opened. Try again.');
}
