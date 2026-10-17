// WHERE A PERSON'S AVATAR AND A PROJECT'S LOGO ARE SERVED FROM. Pages carry a version number, never the picture itself.

// -- CONSTANTS -- //

/** The picture types the upload areas offer. The server checks the type, the size (200 KB) and the file's own signature again. */
export const PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp';

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
	// The same test as userPictureV in SQL: a small PNG, JPEG or WebP data address
	if (!u.image || u.image.length > 300_000 || !/^data:image\/(png|jpeg|webp);base64,/.test(u.image))
		return null;
	if (!u.updatedAt) return null;
	return new Date(u.updatedAt).getTime();
}
