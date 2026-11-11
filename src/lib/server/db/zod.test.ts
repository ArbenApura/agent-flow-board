import { describe, expect, it } from 'vitest';
import { tabNameFromTitle } from '../../shared/tabName';
import { NOTE_LIMITS, noteNumberOf, noteRef, sniffPicture } from '../../shared/notes';
import {
	continueChoice,
	itemInsert,
	noteCreateInput,
	noteFileInsert,
	noteFolderInput,
	noteLinkInput,
	noteUpdateInput,
	projectInsert,
	projectPinInput,
	tabNameSchema
} from './zod';

const ids = {
	orgId: '00000000-0000-4000-8000-000000000001',
	projectId: '00000000-0000-4000-8000-000000000011'
};

describe('tab names', () => {
	it('accepts 1 to 3 UPPERCASE words joined by underscores', () => {
		for (const ok of ['ROOM_TYPES', 'AUTH', 'A_B_C', 'SAVED_CARDS_V2'])
			expect(tabNameSchema.safeParse(ok).success, ok).toBe(true);
	});
	it('refuses lowercase, 4 words, spaces, a leading digit and anything over 30', () => {
		for (const bad of ['room_types', 'A_B_C_D', 'ROOM TYPES', '1ABC', '_AB', 'A'.repeat(31), ''])
			expect(tabNameSchema.safeParse(bad).success, bad).toBe(false);
	});
	it('builds a name from a title when none is given', () => {
		expect(tabNameFromTitle('Fix the billing simulation findings')).toBe('FIX_THE_BILLING');
		expect(tabNameFromTitle('   ')).toBe('ITEM');
		expect(tabNameFromTitle('Resubmission of the extraordinarily long designation')).toMatch(
			/^[A-Z0-9_]{1,30}$/
		);
	});
	it('is applied to the item insert schema', () => {
		const base = { ...ids, number: 1, ref: 'AAA-1', title: 'A good title' };
		expect(itemInsert.safeParse({ ...base, tabName: 'ROOM_TYPES' }).success).toBe(true);
		expect(itemInsert.safeParse({ ...base, tabName: 'room types' }).success).toBe(false);
		expect(itemInsert.safeParse({ ...base, title: 'no' }).success).toBe(false);
	});
});

describe('project rules', () => {
	it('refuses a bad project key', () => {
		expect(projectInsert.safeParse({ orgId: ids.orgId, key: 'hapr', name: 'x' }).success).toBe(
			false
		);
		expect(projectInsert.safeParse({ orgId: ids.orgId, key: 'HAPR', name: 'x' }).success).toBe(
			true
		);
	});
});

describe('continue choice', () => {
	it('accepts a tool with a way it can do', () => {
		for (const ok of [
			{ continueTool: 'claude-code', continueMode: 'vscode' },
			{ continueTool: 'claude-code', continueMode: 'command' },
			{ continueTool: 'codex', continueMode: 'command' },
			{ continueTool: 'other', continueMode: 'prompt' }
		])
			expect(continueChoice.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
	});
	it('refuses Open in VS Code for a tool that has no link', () => {
		expect(
			continueChoice.safeParse({ continueTool: 'codex', continueMode: 'vscode' }).success
		).toBe(false);
		expect(
			continueChoice.safeParse({ continueTool: 'gemini', continueMode: 'vscode' }).success
		).toBe(false);
	});
	it('refuses an unknown tool or way and a missing field', () => {
		expect(continueChoice.safeParse({ continueTool: 'x', continueMode: 'prompt' }).success).toBe(
			false
		);
		expect(continueChoice.safeParse({ continueTool: 'codex', continueMode: 'run' }).success).toBe(
			false
		);
		expect(continueChoice.safeParse({ continueTool: 'codex' }).success).toBe(false);
	});
});

describe('project pin', () => {
	it('takes a project id and nothing else', () => {
		expect(projectPinInput.safeParse({ projectId: ids.projectId }).success).toBe(true);
		// Extra keys such as the person or the org are dropped, never trusted
		const parsed = projectPinInput.parse({ projectId: ids.projectId, userId: 'someone-else' });
		expect(Object.keys(parsed)).toEqual(['projectId']);
	});
	it('refuses a missing or malformed project id', () => {
		for (const bad of [{}, { projectId: 'not-a-uuid' }, { projectId: '' }])
			expect(projectPinInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
	});
});

describe('notes', () => {
	it('a note needs a title within the limit and a body within the limit', () => {
		expect(noteCreateInput.safeParse({ title: 'Billing rules' }).success).toBe(true);
		expect(noteCreateInput.safeParse({ title: '   ' }).success).toBe(false);
		expect(noteCreateInput.safeParse({ title: 'a'.repeat(NOTE_LIMITS.title + 1) }).success).toBe(
			false
		);
		expect(
			noteCreateInput.safeParse({ title: 'Long', body: 'a'.repeat(NOTE_LIMITS.body) }).success
		).toBe(true);
		expect(
			noteCreateInput.safeParse({ title: 'Long', body: 'a'.repeat(NOTE_LIMITS.body + 1) }).success
		).toBe(false);
	});
	it('a create or a change never takes the org, the number, the author or the cause from the caller', () => {
		const parsed = noteCreateInput.parse({
			title: 'T',
			orgId: ids.orgId,
			number: 9,
			createdBy: 'someone-else',
			cause: 'typing',
			epoch: 5
		});
		expect(Object.keys(parsed)).toEqual(['title']);
		expect(
			Object.keys(noteUpdateInput.parse({ body: 'x', version: 3, publicEnabled: true }))
		).toEqual(['body']);
	});
	it('visibility is public or private and nothing else', () => {
		expect(noteUpdateInput.safeParse({ visibility: 'private' }).success).toBe(true);
		expect(noteUpdateInput.safeParse({ visibility: 'secret' }).success).toBe(false);
	});
	it('a folder name is 1 to 80 characters with no slash', () => {
		expect(noteFolderInput.safeParse({ name: 'Research' }).success).toBe(true);
		for (const bad of ['', '  ', 'a/b', 'a\\b', 'a'.repeat(NOTE_LIMITS.folderName + 1)])
			expect(noteFolderInput.safeParse({ name: bad }).success, bad).toBe(false);
		expect(noteFolderInput.safeParse({ name: 'ok', parentId: 'not-a-uuid' }).success).toBe(false);
	});
	it('a link names one of the four kinds and an id', () => {
		expect(noteLinkInput.safeParse({ targetKind: 'task', targetId: ids.projectId }).success).toBe(
			true
		);
		expect(noteLinkInput.safeParse({ targetKind: 'user', targetId: ids.projectId }).success).toBe(
			false
		);
		expect(noteLinkInput.safeParse({ targetKind: 'task', targetId: 'T-1' }).success).toBe(false);
	});
	it('a picture is one of four types and at most 25 MB', () => {
		const base = { ...ids, noteId: ids.projectId, storageKey: 'notes/a', checksum: 'x' };
		expect(noteFileInsert.safeParse({ ...base, mime: 'image/png', size: 10 }).success).toBe(true);
		expect(noteFileInsert.safeParse({ ...base, mime: 'image/svg+xml', size: 10 }).success).toBe(
			false
		);
		expect(
			noteFileInsert.safeParse({ ...base, mime: 'image/png', size: NOTE_LIMITS.pictureBytes + 1 })
				.success
		).toBe(false);
		expect(noteFileInsert.safeParse({ ...base, mime: 'image/png', size: 0 }).success).toBe(false);
	});
	it('the picture type is read from the first bytes, and anything else is refused', () => {
		const pad = (head: number[]) => new Uint8Array([...head, ...new Array(16).fill(0)]);
		expect(sniffPicture(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
		expect(sniffPicture(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
		expect(sniffPicture(pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
		expect(
			sniffPicture(
				new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0])
			)
		).toBe('image/webp');
		expect(sniffPicture(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">'))).toBe(
			null
		);
		expect(sniffPicture(new Uint8Array([]))).toBe(null);
	});
	it('a note reference is N- and its number', () => {
		expect(noteRef(12)).toBe('N-12');
		expect(noteNumberOf('n-12')).toBe(12);
		for (const bad of ['N-0', 'N-', 'T-12', 'N-1x', 'N-12345678901'])
			expect(noteNumberOf(bad)).toBe(null);
	});
});
