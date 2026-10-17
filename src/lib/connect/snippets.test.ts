import { describe, expect, it } from 'vitest';
import { snippets } from './snippets';

describe('connect snippets', () => {
	const all = snippets('https://board.example.com');
	it('covers every supported tool, plus a generic option', () => {
		expect(all.map((s) => s.id)).toEqual([
			'claude-code',
			'claude-ai',
			'vscode',
			'antigravity',
			'other'
		]);
	});
	it('uses the server address and never carries a secret', () => {
		for (const s of all) {
			expect(s.code).toContain('board.example.com');
			expect(s.code).not.toMatch(/afb_[A-Za-z0-9]{10,}/);
		}
	});
	it('the JSON snippets are valid JSON', () => {
		for (const s of all.filter((x) => x.language === 'json'))
			expect(() => JSON.parse(s.code), s.id).not.toThrow();
	});
});
