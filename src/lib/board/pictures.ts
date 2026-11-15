// WHERE A PERSON'S AVATAR AND A PROJECT'S LOGO ARE SERVED FROM. Pages carry a version number, never the picture itself.

// IMPORTED CONSTANTS
import { MAX_STORED_LENGTH } from '#lib/shared/pictures.js';

// -- CONSTANTS -- //

/** The files the upload areas offer: any picture the browser can read. The editor turns it into a small PNG, JPEG or WebP, and the server checks the type, the size (512 KB) and the file's own signature again. */
export const PICTURE_ACCEPT = 'image/*';

// -- FUNCTIONS -- //

/** The address of a person's avatar, or null when they have none. The version changes with every upload, so a changed picture is a new address. */
export const userPictureUrl = (id: string | null | undefined, v: number | null | undefined) =>
	id && v ? `/pictures/user/${encodeURIComponent(id)}?v=${v}` : null;

/** The address of a project's logo, or null when it has none. */
export const projectPictureUrl = (id: string | null | undefined, v: number | null | undefined) =>
	id && v ? `/pictures/project/${encodeURIComponent(id)}?v=${v}` : null;

/**
 * The version of the signed in person's avatar, read from the session's user. Only a picture the person uploaded counts: an
 * address a sign in provider stored in the same field is left out, so no page asks another site for it.
 */
export function avatarVersion(u: {
	image?: string | null;
	updatedAt?: Date | string | null;
}): number | null {
	// The same test as userPictureV in SQL: a PNG, JPEG or WebP data address of up to 512 KB
	if (
		!u.image ||
		u.image.length > MAX_STORED_LENGTH ||
		!/^data:image\/(png|jpeg|webp);base64,/.test(u.image)
	)
		return null;
	if (!u.updatedAt) return null;
	return new Date(u.updatedAt).getTime();
}
