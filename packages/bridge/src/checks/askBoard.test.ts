// TESTS OF ASKING THE OWNER ON THE BOARD, WITH A FAKE BOARD: APPROVED, REFUSED, EXPIRED, CANCELLED, A LATE CLAIM, A REPLAY, A WRONG TARGET, TWO AGENTS, A 25 ENTRY BATCH.

// -- DEP-MODULES -- //
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { ASK_LIMIT, askOwner, parseEntries, type AskBoard } from './askBoard.js';
import { consumeApproval, consumeApprovalNote, mintFromDecision, peekApproval } from './approve.js';
import { BoardError } from './board.js';
import { approveCommand } from './commands.js';
import { approvalsFile } from './paths.js';

// -- TYPES -- //

type Row = {
	id: string;
	action: string;
	target: string;
	status: string;
	batchId: string | null;
	expiresAt: string;
};

// -- FUNCTIONS -- //

/** A board in memory: the owner's click is `decide`, a claim answers only an approved row once. */
function fakeBoard() {
	const rows: Row[] = [];
	let n = 0;
	const calls: string[] = [];
	const board: AskBoard & { rows: Row[]; calls: string[]; decide(status: string): void } = {
		rows,
		calls,
		decide(status) {
			for (const r of rows) if (r.status === 'pending') r.status = status;
		},
		async requestApprovals(input) {
			calls.push('request');
			const batchId = input.entries.length > 1 ? 'batch' : null;
			const made = input.entries.map((e) => {
				const same = rows.find(
					(r) =>
						r.status === 'pending' && r.action === e.action && r.target === e.target.toLowerCase()
				);
				if (same) return same;
				const row: Row = {
					id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
					action: e.action,
					target: e.action === 'roots' ? e.target : e.target.toLowerCase(),
					status: 'pending',
					batchId,
					expiresAt: new Date(Date.now() + 1800_000).toISOString()
				};
				rows.push(row);
				return row;
			});
			return {
				batchId,
				requests: made.map((r) => ({ ...r }) as never),
				link: 'http://board.test/o/P/settings#checks-waiting'
			};
		},
		async pollApprovals(ids) {
			calls.push('poll');
			return rows.filter((r) => ids.includes(r.id)).map((r) => ({ ...r }) as never);
		},
		async cancelApprovals(ids) {
			calls.push('cancel');
			for (const r of rows)
				if (ids.includes(r.id) && r.status === 'pending') r.status = 'cancelled';
		},
		async claimApprovals(ids) {
			calls.push('claim');
			const out = [];
			for (const r of rows)
				if (ids.includes(r.id) && r.status === 'approved') {
					r.status = 'claimed';
					out.push({
						id: r.id,
						action: r.action,
						target: r.target,
						decidedBy: 'Arben',
						decidedAt: '2026-11-09T08:00:00.000Z'
					});
				}
			return out;
		}
	};
	return board;
}

describe('asking the owner on the board', () => {
	let base = '';
	let saved: string | undefined;
	const say: string[] = [];
	const opts = { say: (l: string) => void say.push(l), pollMs: 1, sleep: async () => undefined };
	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-ask-')));
		saved = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
		say.length = 0;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = saved;
		rmSync(base, { recursive: true, force: true });
	});
	/** The click happens during the first wait: the fake sleep decides. */
	const clicking = (b: ReturnType<typeof fakeBoard>, status = 'approved') => ({
		...opts,
		sleep: async () => b.decide(status)
	});

	it('approved: files, prints the link, claims once and makes a code that works once, with the board note', async () => {
		const b = fakeBoard();
		const r = await askOwner(b, {
			...clicking(b),
			entries: [{ action: 'secrets', target: 'MangoMan/HAPRM' }],
			waitMinutes: 10
		});
		expect(r.state).toBe('approved');
		if (r.state !== 'approved') return;
		expect(say[0]).toContain('http://board.test/o/P/settings#checks-waiting');
		expect(r.codes).toHaveLength(1);
		const note = consumeApprovalNote('secrets', 'mangoman/haprm', r.codes[0]!.code);
		expect(note.ok).toBe(true);
		expect(note.note?.by).toBe('Arben');
		expect(consumeApproval('secrets', 'mangoman/haprm', r.codes[0]!.code)).toBe(false);
		expect(
			readFileSync(join(base, 'bridge-home', 'checks', 'audit.log'), 'utf8').length
		).toBeGreaterThan(0);
	});

	it('refused, expired and cancelled stop with one plain sentence and make no code', async () => {
		for (const [status, words] of [
			['refused', /refused/],
			['expired', /ran out of time/],
			['cancelled', /withdrawn/]
		] as const) {
			const b = fakeBoard();
			await expect(
				askOwner(b, {
					...clicking(b, status),
					entries: [{ action: 'register', target: 'a.example.com' }],
					waitMinutes: 10
				})
			).rejects.toThrow(words);
			expect(b.calls).not.toContain('claim');
		}
	});

	it('waiting: returns the ids to resume, and resume picks it up and claims', async () => {
		const b = fakeBoard();
		const first = await askOwner(b, {
			...opts,
			entries: [{ action: 'pictures', target: 'HAPRM' }],
			waitMinutes: 0
		});
		expect(first.state).toBe('waiting');
		if (first.state !== 'waiting') return;
		b.decide('approved');
		const second = await askOwner(b, { ...opts, entries: [], resume: first.ids, waitMinutes: 1 });
		expect(second.state).toBe('approved');
	});

	it('a late claim finds the row gone and a replay finds it claimed: no code', async () => {
		const b = fakeBoard();
		const first = await askOwner(b, {
			...opts,
			entries: [{ action: 'register', target: 'late.example.com' }],
			waitMinutes: 0
		});
		if (first.state !== 'waiting') throw new Error('expected waiting');
		b.decide('approved');
		b.rows[0]!.status = 'expired';
		await expect(
			askOwner(b, { ...opts, entries: [], resume: first.ids, waitMinutes: 1 })
		).rejects.toThrow(/ran out of time/);
		b.rows[0]!.status = 'claimed';
		await expect(
			askOwner(b, { ...opts, entries: [], resume: first.ids, waitMinutes: 1 })
		).rejects.toThrow(/already used/);
	});

	it('a board answer that was not asked for makes no code', async () => {
		const b = fakeBoard();
		const orig = b.claimApprovals.bind(b);
		b.claimApprovals = async (ids) =>
			(await orig(ids)).map((c) => ({ ...c, target: 'somewhere-else' }));
		await expect(
			askOwner(b, {
				...clicking(b),
				entries: [{ action: 'secrets', target: 'o/A' }],
				waitMinutes: 10
			})
		).rejects.toThrow(/not asked for/);
	});

	it('mintFromDecision refuses a made-up decision, and a flag cannot make a code', () => {
		expect(() =>
			mintFromDecision({
				id: 'x',
				action: 'secrets',
				target: 'o/A',
				decidedBy: 'me',
				decidedAt: 'now'
			})
		).toThrow(/decision the board gave/);
		expect(peekApproval('secrets', 'o/A', 'AAAA-AAAA-AAAA')).toBe(false);
	});

	it('two agents asking for the same target get the same row, and one claim only', async () => {
		const b = fakeBoard();
		const a1 = await askOwner(b, {
			...opts,
			entries: [{ action: 'secrets', target: 'o/SAME' }],
			waitMinutes: 0
		});
		const a2 = await askOwner(b, {
			...opts,
			entries: [{ action: 'secrets', target: 'O/same' }],
			waitMinutes: 0
		});
		if (a1.state !== 'waiting' || a2.state !== 'waiting') throw new Error('expected waiting');
		expect(a1.ids).toEqual(a2.ids);
		expect(b.rows).toHaveLength(1);
	});

	it('a batch yields exactly its entries and no more, and a partly used batch leaves the rest valid', async () => {
		const b = fakeBoard();
		const r = await askOwner(b, {
			...clicking(b),
			entries: parseEntries('secrets:o/A; register:b.example.com; pictures:a'),
			waitMinutes: 10
		});
		if (r.state !== 'approved') throw new Error('expected approved');
		expect(r.codes.map((c) => c.action).sort()).toEqual(['pictures', 'register', 'secrets']);
		expect(
			consumeApproval('secrets', 'o/a', r.codes.find((c) => c.action === 'secrets')!.code)
		).toBe(true);
		expect(
			peekApproval('register', 'b.example.com', r.codes.find((c) => c.action === 'register')!.code)
		).toBe(true);
	});

	it('refuses a 25 entry batch before anything is asked, and a bad entry', async () => {
		const many = Array.from({ length: ASK_LIMIT + 5 }, (_, i) => `register:h${i}.example.com`).join(
			';'
		);
		expect(() => parseEntries(many)).toThrow(/at most 20/);
		expect(() => parseEntries('nothing:x')).toThrow(/not <action>:<target>/);
		const b = fakeBoard();
		await expect(
			askOwner(b, {
				...opts,
				entries: Array.from({ length: 25 }, (_, i) => ({ action: 'register', target: `h${i}` })),
				waitMinutes: 0
			})
		).rejects.toThrow(/At most 20/);
		expect(b.calls).toEqual([]);
	});

	it('an abort withdraws the request so no card stays', async () => {
		const b = fakeBoard();
		const ac = new AbortController();
		await expect(
			askOwner(b, {
				...opts,
				sleep: async () => ac.abort(),
				signal: ac.signal,
				entries: [{ action: 'roots', target: base }],
				waitMinutes: 10
			})
		).rejects.toThrow(/withdrawn/);
		expect(b.rows[0]!.status).toBe('cancelled');
	});

	it('an older board (404) and a switched-off board (403) give the terminal fallback; an unreachable one says so', async () => {
		const mk = (e: unknown): AskBoard => ({
			...fakeBoard(),
			requestApprovals: async () => {
				throw e;
			}
		});
		const one = {
			entries: [{ action: 'register', target: 'x.example.com' }],
			waitMinutes: 0,
			...opts
		};
		await expect(
			askOwner(mk(new BoardError(404, 'NOT_FOUND', 'No such runner call.')), one)
		).rejects.toThrow(/older.*terminal/s);
		await expect(
			askOwner(mk(new BoardError(403, 'FORBIDDEN', 'Approvals on the board are off.')), one)
		).rejects.toThrow(/off.*terminal/s);
		await expect(askOwner(mk(new TypeError('fetch failed')), one)).rejects.toThrow(
			/could not be reached.*terminal/s
		);
	});

	it('the command: exit 0 with codes, exit 3 when still waiting, and the terminal path still needs a terminal', async () => {
		const out: string[] = [];
		const b = fakeBoard();
		const ctx = {
			log: (l: string) => void out.push(l),
			out: (l: string) => void out.push(l),
			json: true,
			board: () => b
		};
		const wait = await approveCommand(
			['--request', '--action', 'pictures', '--target', 'haprm', '--wait', '0'],
			ctx
		);
		expect(wait).toBe(3);
		const waiting = JSON.parse(out.at(-1)!) as { resume: string };
		b.decide('approved');
		out.length = 0;
		const done = await approveCommand(['--resume', waiting.resume, '--wait', '1'], ctx);
		expect(done).toBe(0);
		expect(JSON.parse(out.at(-1)!).codes).toHaveLength(1);
		out.length = 0;
		expect(
			await approveCommand(['--action', 'register', '--target', 'x'], { ...ctx }, { isTTY: false })
		).toBe(1);
		void approvalsFile;
	});
});
