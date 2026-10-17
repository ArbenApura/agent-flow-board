import { describe, expect, it } from 'vitest';
import { tabNameFromTitle } from '../../shared/uiChange';
import { continueChoice, itemInsert, projectInsert, tabNameSchema, uiChangeInput } from './zod';

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

describe('project and UI change rules', () => {
	it('refuses a bad project key', () => {
		expect(projectInsert.safeParse({ orgId: ids.orgId, key: 'hapr', name: 'x' }).success).toBe(
			false
		);
		expect(projectInsert.safeParse({ orgId: ids.orgId, key: 'HAPR', name: 'x' }).success).toBe(
			true
		);
	});

	const row = {
		page: '/sign-in',
		stateRecipe: '',
		themes: ['light', 'dark'],
		accounts: 'default',
		siblings: ['/'],
		levels: ['title', 'button-primary=css:.save button'],
		viewports: [1440, 390]
	};
	it('accepts a complete row', () => {
		expect(uiChangeInput.safeParse(row).success).toBe(true);
		expect(
			uiChangeInput.safeParse({ ...row, stateRecipe: 'click:text=Areas > wait:.list' }).success
		).toBe(true);
	});
	it('refuses an unknown level, a missing column, a bad viewport and 4 siblings', () => {
		expect(uiChangeInput.safeParse({ ...row, levels: ['heading'] }).success).toBe(false);
		expect(uiChangeInput.safeParse({ ...row, levels: ['title=.x'] }).success).toBe(false);
		const { siblings: _s, ...missing } = row;
		expect(uiChangeInput.safeParse(missing).success).toBe(false);
		expect(uiChangeInput.safeParse({ ...row, viewports: [800] }).success).toBe(false);
		expect(uiChangeInput.safeParse({ ...row, siblings: ['/a', '/b', '/c', '/d'] }).success).toBe(
			false
		);
	});
	it('refuses a state step that is not click, wait or scroll, and a route outside the app', () => {
		expect(uiChangeInput.safeParse({ ...row, stateRecipe: 'submit:form' }).success).toBe(false);
		expect(uiChangeInput.safeParse({ ...row, page: 'sign-in' }).success).toBe(false);
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
