// NOTES: THE LIMITS AND THE REFERENCE FORM, SHARED BY THE SERVER AND THE SCREENS (AFB-20261111-0035)
// The numbers marked PROPOSED wait for the owner's word; they are in one place so changing one is one edit.

// -- CONSTANTS -- //

export const NOTE_LIMITS = {
	/** Characters in a title. */
	title: 200,
	/** Characters in a folder name. */
	folderName: 80,
	/** Characters in a note body (PROPOSED). */
	body: 200_000,
	/** Bytes of one picture (the owner's number, 25 MB). */
	pictureBytes: 25 * 1024 * 1024,
	/** Bytes of all the pictures of one note (PROPOSED, 200 MB). */
	notePictureBytes: 200 * 1024 * 1024,
	/** Picture uploads one person may have running at once. */
	uploadsAtOnce: 2,
	/** Bytes of one live update. */
	updateBytes: 256 * 1024,
	/** Bytes of the live updates of one note before they are merged. */
	noteUpdateBytes: 5 * 1024 * 1024,
	/** Bytes of one presence message. */
	presenceBytes: 1024,
	/** Live editing calls one person may make in a minute (PROPOSED). */
	syncPerMinute: 600,
	/** Minutes between two versions kept while people type (PROPOSED). */
	typingVersionMinutes: 10,
	/** The deepest a folder may sit. People never reach it; it guards the recursive queries. */
	folderDepth: 100
} as const;

/** The picture types a note accepts. SVG is refused: it can carry script. */
export const NOTE_PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type NotePictureType = (typeof NOTE_PICTURE_TYPES)[number];

const NOTE_REF = /^N-([1-9]\d{0,8})$/i;

// -- FUNCTIONS -- //

/** The reference of a note, for example N-12. */
export const noteRef = (number: number) => `N-${number}`;

/**
 * The one address a note picture is read from (the afb:file/<id> of a note's text becomes this). It carries the org so the
 * read route can open the right tenant; the route checks the reader against the picture's own note.
 */
export const noteFileUrl = (orgSlug: string, fileId: string) =>
	`/api/v1/orgs/${encodeURIComponent(orgSlug)}/notes/files/${encodeURIComponent(fileId)}`;

/** The number inside a note reference, or null when the text is not one. */
export function noteNumberOf(ref: string): number | null {
	const m = NOTE_REF.exec(ref.trim());
	return m ? Number(m[1]) : null;
}

/**
 * The picture type the first bytes of a file say it is, or null. The name and the type the browser sent are never trusted.
 */
export function sniffPicture(bytes: Uint8Array): NotePictureType | null {
	const at = (i: number, ...want: number[]) => want.every((b, k) => bytes[i + k] === b);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
	if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
	if (
		at(0, 0x47, 0x49, 0x46, 0x38) &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61
	)
		return 'image/gif';
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
	return null;
}
