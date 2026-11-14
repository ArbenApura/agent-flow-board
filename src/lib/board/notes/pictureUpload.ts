// PICTURES IN THE NOTE EDITOR: THE CHECK BEFORE AN UPLOAD, THE PLAIN ERROR LINES, AND THE TWO WAYS A PICTURE ADDRESS IS WRITTEN (AFB-20261111-0035, STEP 4.5)
// A picture is stored as afb:file/<id> in the note's text and Markdown. The editor shows it from the real address
// (noteFileUrl), and copying it out of the editor turns that address back into afb:file/<id>.

// IMPORTED MODULES
import { ApiError } from '#lib/board/api.js';
import { NOTE_LIMITS, NOTE_PICTURE_TYPES, noteFileUrl } from '#lib/shared/notes.js';

// -- TYPES -- //

export interface UploadedPicture {
	id: string;
	mime: string;
	size: number;
	/** What to write in the note's text, ![](afb:file/<id>). */
	markdown: string;
}

export type UploadOutcome = { ok: true; id: string } | { ok: false; line: string };

// -- CONSTANTS -- //

/** The value of the file picker's accept attribute. */
export const PICTURE_ACCEPT = NOTE_PICTURE_TYPES.join(',');

const FILE_SRC = /^afb:file\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** The real address of a picture, with or without the site in front. */
const FILE_URL =
	/^(?:https?:\/\/[^/]+)?\/api\/v1\/orgs\/[^/?#]+\/notes\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#].*)?$/i;

const TOO_LARGE = 'That picture is larger than 25 MB.';
const NOT_A_PICTURE = 'Use a PNG, JPEG, WebP or GIF picture.';
const FAILED = 'The picture could not be uploaded. Try again.';

// -- FUNCTIONS -- //

/**
 * The line to show when a file cannot be a note picture, or null when it may be sent. The type the browser reports is only
 * used to refuse early; the server looks at the first bytes, so an empty type is let through to it.
 */
export function checkPicture(file: { size: number; type: string }): string | null {
	if (file.type && !(NOTE_PICTURE_TYPES as readonly string[]).includes(file.type.toLowerCase()))
		return NOT_A_PICTURE;
	if (file.size > NOTE_LIMITS.pictureBytes) return TOO_LARGE;
	if (file.size === 0) return 'That picture is empty.';
	return null;
}

/** A plain line for an upload that failed, from what the server or the network said. */
export function uploadErrorLine(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 413) return TOO_LARGE;
		if (error.status === 429 || error.code === 'RATE_LIMITED')
			return 'Two pictures are already uploading. Wait for one to finish.';
		if (error.status === 401 || error.status === 403 || error.code === 'FORBIDDEN')
			return 'You can no longer add pictures to this note.';
		// The server's own words for a refused picture are already plain
		if (error.status === 400 || error.code === 'INVALID') return error.message || FAILED;
		return FAILED;
	}
	return 'The picture could not be uploaded. Check your connection and try again.';
}

/** Checks a file, sends it and says in one value whether it worked. The sender is passed in so this runs without a network. */
export async function uploadPicture(
	file: File,
	send: (file: File) => Promise<UploadedPicture>
): Promise<UploadOutcome> {
	const refused = checkPicture(file);
	if (refused) return { ok: false, line: refused };
	try {
		const done = await send(file);
		if (!done?.id) return { ok: false, line: FAILED };
		return { ok: true, id: done.id };
	} catch (e) {
		return { ok: false, line: uploadErrorLine(e) };
	}
}

/**
 * The picture files of a paste or a drop. A paste that also carries text (a spreadsheet cell copied with its picture) is a
 * text paste and sends nothing; a drop is always about the files.
 */
export function picturesOf(
	files: ArrayLike<File> | null | undefined,
	options: { hasText: boolean }
): File[] {
	if (!files || options.hasText) return [];
	return Array.from(files).filter((f) => f.type.toLowerCase().startsWith('image/'));
}

/** The address the editor shows for a stored picture address; anything else is shown as it is. */
export function displaySrc(src: string, org: string | undefined): string {
	const m = FILE_SRC.exec(src);
	return m && org ? noteFileUrl(org, m[1].toLowerCase()) : src;
}

/** The address a note stores for a picture the editor shows from its real address (what a copy and paste brings back). */
export function storedSrc(src: string | null | undefined): string | null {
	if (!src) return null;
	const m = FILE_URL.exec(src);
	return m ? `afb:file/${m[1].toLowerCase()}` : src;
}
