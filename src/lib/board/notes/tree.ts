// THE FOLDER TREE OF THE NOTES PAGE AS PLAIN DATA: WHICH ROWS SHOW, HOW FAR THEY INDENT, WHERE A FOLDER MAY MOVE AND WHAT THE ARROW KEYS DO
// The server sends the folders as a flat list in path order (ops/noteFolders.ts). Everything here is pure, so it is tested without a screen.

// -- TYPES -- //

export type Folder = {
	id: string;
	parentId: string | null;
	name: string;
	/** 1 at the top. */
	depth: number;
	/** The names from the top, joined with a slash. */
	path: string;
	/** The notes in it the person may see. */
	notes: number;
};
/** What the list beside the tree shows: every note ('all'), the starred ones ('favourites'), or one folder by its id. */
export type TreeView = string;
export type TreeKey = 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';
export type TreeMove = { focus?: string; expand?: string; collapse?: string };

// -- CONSTANTS -- //

/** A row indents 16 px a level (the spacing step 16) and stops after this many levels, so a row always fits a phone. */
export const INDENT_LEVELS = 6;
// Whole class names on purpose: Tailwind only builds the classes it can read in full
const INDENT = ['pl-0', 'pl-4', 'pl-8', 'pl-12', 'pl-16', 'pl-20'] as const;

// -- FUNCTIONS -- //

/** The left padding of a row at this depth. Level 12 is no wider than level 6. */
export const indentClass = (depth: number): string =>
	INDENT[Math.min(Math.max(Math.trunc(depth), 1), INDENT_LEVELS) - 1];

/** True for a folder too deep to show its place by indent alone: its path is shown as a line of text instead. */
export const pastIndent = (depth: number): boolean => depth > INDENT_LEVELS;

export const hasChildren = (folders: Folder[], id: string): boolean =>
	folders.some((f) => f.parentId === id);

/** The folders above this one, nearest first. Stops if the data ever held a loop. */
export function ancestorIds(folders: Folder[], id: string): string[] {
	const byId = new Map(folders.map((f) => [f.id, f]));
	const out: string[] = [];
	const seen = new Set<string>([id]);
	let at = byId.get(id)?.parentId ?? null;
	while (at && !seen.has(at)) {
		out.push(at);
		seen.add(at);
		at = byId.get(at)?.parentId ?? null;
	}
	return out;
}

/** Every folder under this one, at any depth. */
export function descendantIds(folders: Folder[], id: string): Set<string> {
	const out = new Set<string>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const f of folders) {
			if (f.parentId && !out.has(f.id) && (f.parentId === id || out.has(f.parentId))) {
				out.add(f.id);
				grew = true;
			}
		}
	}
	out.delete(id);
	return out;
}

/** The rows to draw: a folder shows when every folder above it is open. The order of the list (path order) is kept. */
export function visibleRows(folders: Folder[], expanded: ReadonlySet<string>): Folder[] {
	const hidden = new Set<string>();
	const out: Folder[] = [];
	for (const f of folders) {
		if (f.parentId && (hidden.has(f.parentId) || !expanded.has(f.parentId))) {
			hidden.add(f.id);
			continue;
		}
		out.push(f);
	}
	return out;
}

/** The folders that must be open for this one to show. */
export const openTo = (folders: Folder[], id: string | null): string[] =>
	id ? ancestorIds(folders, id) : [];

/** Where a folder may move: anywhere but itself and the folders inside it. A note may move anywhere, so pass null. */
export function moveTargets(folders: Folder[], movingFolderId: string | null): Folder[] {
	if (!movingFolderId) return folders;
	const inside = descendantIds(folders, movingFolderId);
	return folders.filter((f) => f.id !== movingFolderId && !inside.has(f.id));
}

/** The folders from the top down to this one, for a breadcrumb. */
export function crumbs(folders: Folder[], id: string | null): { id: string; name: string }[] {
	if (!id) return [];
	const byId = new Map(folders.map((f) => [f.id, f]));
	return [...ancestorIds(folders, id).reverse(), id]
		.map((x) => byId.get(x))
		.filter((f): f is Folder => !!f)
		.map((f) => ({ id: f.id, name: f.name }));
}

/**
 * What an arrow key does in the tree, as a screen reader expects of one: down and up move, right opens a closed folder or
 * steps into an open one, left closes an open folder or steps to its parent, Home and End jump.
 */
export function treeKey(
	folders: Folder[],
	expanded: ReadonlySet<string>,
	currentId: string,
	key: TreeKey
): TreeMove {
	const rows = visibleRows(folders, expanded);
	const i = rows.findIndex((r) => r.id === currentId);
	if (i < 0) return rows.length ? { focus: rows[0].id } : {};
	const row = rows[i];
	const parent = hasChildren(folders, row.id);
	switch (key) {
		case 'ArrowDown':
			return i < rows.length - 1 ? { focus: rows[i + 1].id } : {};
		case 'ArrowUp':
			return i > 0 ? { focus: rows[i - 1].id } : {};
		case 'Home':
			return { focus: rows[0].id };
		case 'End':
			return { focus: rows[rows.length - 1].id };
		case 'ArrowRight':
			if (!parent) return {};
			return expanded.has(row.id) ? { focus: rows[i + 1]?.id } : { expand: row.id };
		case 'ArrowLeft':
			if (parent && expanded.has(row.id)) return { collapse: row.id };
			return row.parentId ? { focus: row.parentId } : {};
	}
}

/** Why a move is not allowed, in the words the person reads, or null when it is. The server checks again. */
export function moveRefusal(
	folders: Folder[],
	movingFolderId: string,
	targetId: string | null
): string | null {
	if (targetId === null) return null;
	if (targetId === movingFolderId) return 'A folder cannot be moved into itself.';
	if (descendantIds(folders, movingFolderId).has(targetId))
		return 'A folder cannot be moved into a folder inside it.';
	return null;
}
