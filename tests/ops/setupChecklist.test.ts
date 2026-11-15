import { describe, expect, it } from 'vitest';
import { setupProgress, setupTiles, type SetupInput } from '../../src/lib/connect/setupChecklist';

const base: SetupInput = {
	connections: 0,
	signIn: { state: 'none', expiresAt: null },
	runners: [],
	marks: {},
	person: 'Alex'
};
const status = (i: Partial<SetupInput>) =>
	Object.fromEntries(setupTiles({ ...base, ...i }).map((t) => [t.key, t.status]));

describe('the setup checklist tiles', () => {
	it('starts with every tile still to do for a person who has done nothing', () => {
		expect(status({})).toEqual({
			tools: 'todo',
			skills: 'todo',
			bridge: 'todo',
			editor: 'todo',
			checks: 'todo',
			token: 'todo'
		});
		const p = setupProgress(setupTiles(base));
		expect(p).toMatchObject({ done: 0, skipped: 0, total: 6, percent: 0, settled: false });
	});

	it('marks connected apps, the bridge sign in and the editor by themselves, and the person own runner', () => {
		const s = status({
			connections: 2,
			signIn: { state: 'signed-in', expiresAt: '2026-12-13T10:30:00Z' },
			runners: [{ online: true }]
		});
		expect(s).toMatchObject({ tools: 'done', bridge: 'done', editor: 'done', checks: 'done' });
		expect(s.skills).toBe('todo');
		expect(s.token).toBe('todo');
	});

	it('shows an ended bridge sign in as needing attention while the bridge itself counts as installed', () => {
		const tiles = setupTiles({
			...base,
			signIn: { state: 'expired', expiresAt: '2026-11-10T10:30:00Z' }
		});
		expect(tiles.find((t) => t.key === 'editor')).toMatchObject({ status: 'attention' });
		expect(tiles.find((t) => t.key === 'editor')!.text).toContain('2026-11-10 10:30');
		expect(tiles.find((t) => t.key === 'bridge')!.status).toBe('done');
	});

	it('treats a sign in that could not be read as not done, never as done', () => {
		expect(status({ signIn: null })).toMatchObject({ bridge: 'todo', editor: 'todo' });
		expect(status({ runners: null }).checks).toBe('todo');
	});

	it('counts only the runners handed in, so a colleague runner never completes the tile', () => {
		// The server hands in the person's own runners only; with none the tile is to do whoever else has one
		expect(status({ runners: [] }).checks).toBe('todo');
		expect(
			setupTiles({ ...base, runners: [{ online: false }] }).find((t) => t.key === 'checks')
		).toMatchObject({
			status: 'done',
			text: 'Your check runner is registered but offline now.'
		});
	});

	it('lets the person mark skills and the token done, or skip any tile, and undo it', () => {
		expect(status({ marks: { skills: 'done' } }).skills).toBe('done');
		expect(status({ marks: { token: 'skipped', checks: 'skipped' } })).toMatchObject({
			token: 'skipped',
			checks: 'skipped'
		});
		// Undone: no mark is back to to do
		expect(status({ marks: {} }).token).toBe('todo');
	});

	it('ignores a done mark on a tile the board knows, and never lets a skip hide what is done', () => {
		expect(status({ marks: { tools: 'done' } }).tools).toBe('todo');
		expect(status({ connections: 1, marks: { tools: 'skipped' } }).tools).toBe('done');
	});

	it('is settled once every tile is done or skipped, and says how many are of each', () => {
		const p = setupProgress(
			setupTiles({
				connections: 1,
				signIn: { state: 'signed-in', expiresAt: null },
				runners: [{ online: true }],
				marks: { skills: 'done', token: 'skipped' },
				person: 'Alex'
			})
		);
		expect(p).toMatchObject({ done: 5, skipped: 1, total: 6, percent: 83, settled: true });
		const open = setupProgress(setupTiles({ ...base, marks: { skills: 'skipped' } }));
		expect(open.settled).toBe(false);
	});

	it('words the editor tile for Claude Code only', () => {
		const t = setupTiles(base).find((x) => x.key === 'editor')!;
		expect(t.text).toContain('This only supports Claude Code.');
		expect(t.text).not.toMatch(/for now/i);
	});
});
