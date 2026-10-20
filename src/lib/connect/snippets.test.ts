import { describe, expect, it } from 'vitest';
import { snippets } from './snippets';

describe('connect snippets', () => {
	const all = snippets('https://board.example.com', 'arbenger');
	it('covers every supported tool, plus a generic option', () => {
		expect(all.map((s) => s.id)).toEqual([
			'claude-code',
			'claude-ai',
			'vscode',
			'antigravity',
			'other'
		]);
	});
	it('names every connection after the organisation and points at its own address', () => {
		for (const s of all) {
			expect(s.code, s.id).toContain('https://board.example.com');
			if (s.id === 'other') continue;
			expect(s.code + s.signIn, s.id).toContain('afb-arbenger');
		}
		for (const s of all.filter((x) => x.id !== 'antigravity' && x.id !== 'other'))
			expect(s.code, s.id).toContain('https://board.example.com/mcp/arbenger');
		expect(all.find((s) => s.id === 'antigravity')!.code).toContain('"--org"');
	});
	it('two organisations never share a connection name or address', () => {
		const a = snippets('https://board.example.com', 'arbenger').find(
			(s) => s.id === 'claude-code'
		)!;
		const b = snippets('https://board.example.com', 'mangoman').find(
			(s) => s.id === 'claude-code'
		)!;
		expect(a.code).not.toBe(b.code);
		expect(b.code).toBe(
			'claude mcp add --transport http afb-mangoman https://board.example.com/mcp/mangoman'
		);
	});
	it('without an organisation it shows the plain address', () => {
		const plain = snippets('https://board.example.com').find((s) => s.id === 'claude-code')!;
		expect(plain.code).toBe(
			'claude mcp add --transport http agent-flow-board https://board.example.com/mcp'
		);
	});
	it('never carries a secret', () => {
		for (const s of all) expect(s.code).not.toMatch(/afb_[A-Za-z0-9]{10,}/);
	});
	it('the JSON snippets are valid JSON', () => {
		for (const s of all.filter((x) => x.language === 'json'))
			expect(() => JSON.parse(s.code), s.id).not.toThrow();
	});
});
