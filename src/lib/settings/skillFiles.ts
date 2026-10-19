// THE DRAFT SIDE OF A SKILL'S SUPPORTING FILES: ROWS THE EDITOR CAN RENAME AND EDIT, AND THE SAVE PAYLOAD BUILT FROM THEM
// A row carries an id of its own because its path can be edited, so a keyed list never keys by the path.

// -- TYPES -- //
import type { SkillSupportFile } from '#lib/shared/skills.js';

// -- TYPES -- //

export type DraftFile = { id: string; path: string; body: string };

// -- FUNCTIONS -- //

let counter = 0;

/** The editor rows for the files a skill holds, each with its own id. */
export function toDrafts(files: SkillSupportFile[]): DraftFile[] {
	return files.map((f) => ({ id: `draft-${++counter}`, path: f.path, body: f.body }));
}

/** One new editor row. */
export function newDraft(file: SkillSupportFile): DraftFile {
	return { id: `draft-${++counter}`, path: file.path, body: file.body };
}

/** The files as the verbs take them, in path order, so two drafts of the same files compare equal. */
export function fromDrafts(drafts: DraftFile[]): SkillSupportFile[] {
	return drafts
		.map((d) => ({ path: d.path.trim(), body: d.body }))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** True when the drafts differ from the files the editor opened with. */
export function filesChanged(drafts: DraftFile[], opened: SkillSupportFile[]): boolean {
	return JSON.stringify(fromDrafts(drafts)) !== JSON.stringify(opened);
}
