// PICTURE LIMITS SHARED BY THE SERVER, THE PAGES AND THE PICTURE EDITOR (AFB-20261115-0714)
// A person may choose a file of up to 10 MB. The editor saves a small cropped picture, and the server keeps a ceiling on what is stored.

// -- CONSTANTS -- //

/** The largest file a person may choose in the picture editor. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
/** The largest picture the server stores. An avatar is read with every session, so this stays small: the editor's own output is about 300 KB. */
export const MAX_PICTURE_BYTES = 512 * 1024;
/** A 512 KB picture as a base64 data address, with room for the prefix. Used by the server, the SQL version column and avatarVersion. */
export const MAX_STORED_LENGTH = 700_000;
/** The editor saves a square picture of this many pixels on a side. */
export const PICTURE_OUTPUT_SIZE = 512;
/** The editor steps the quality down until the saved picture is under this size. */
export const PICTURE_TARGET_BYTES = 300 * 1024;
/** A source picture smaller than this on its short side gets a low resolution notice. */
export const PICTURE_MIN_SIDE = 256;
