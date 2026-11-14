// THE `check` COMMAND GROUP: IT IS DISPATCHED, IT NEVER WAITS ON A TERMINAL, AND THE HOOK PATH NEVER LOADS IT

// -- DEP-MODULES -- //
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { checkMain, CHECK_USAGE } from './command.js';
import { recordConnection } from './connections.js';
import { fileStore } from '../tokenStore.js';

// -- FUNCTIONS -- //

describe('the check command group', () => {
	let home: string;
	let before: string | undefined;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'afb-check-cmd-'));
		before = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});
	const ctx = (args: string[]) => {
		const logs: string[] = [];
		const outs: string[] = [];
		return {
			logs,
			outs,
			c: {
				args,
				store: fileStore(home),
				fetch: async () => new Response('', { status: 404 }),
				personalToken: () => null,
				log: (l: string) => logs.push(l),
				out: (l: string) => outs.push(l)
			}
		};
	};

	it('prints its usage and exits 2 for an unknown command', async () => {
		const { c, logs } = ctx(['nonsense']);
		expect(await checkMain(c)).toBe(2);
		expect(logs.join('\n')).toBe(CHECK_USAGE);
	});

	it('status --json answers at once with the state and no problem on a clean home', async () => {
		const { c, outs } = ctx(['status', '--json']);
		expect(await checkMain(c)).toBe(0);
		const state = JSON.parse(outs[0]);
		expect(state.connections).toEqual([]);
		expect(state.registrations).toEqual([]);
		expect(state.problems ?? []).toEqual([]);
	});

	it('doctor lists a connection with no runner token as a problem with its next step, and exits 1', async () => {
		recordConnection({ server: 'https://board.test', org: 'arbenger', name: 'PC' });
		const { c, outs } = ctx(['doctor', '--json']);
		expect(await checkMain(c)).toBe(1);
		const state = JSON.parse(outs[0]);
		expect(state.problems.map((p: { next: string }) => p.next).join(' ')).toMatch(
			/check connect --server https:\/\/board\.test --org arbenger/
		);
	});

	it('clear removes finished runs and says how many', async () => {
		const { c, logs } = ctx(['clear', '--all']);
		expect(await checkMain(c)).toBe(0);
		expect(logs.join(' ')).toMatch(/0 finished run folder/);
	});

	it('connect --project takes a comma list or one quoted list and refuses a stray extra word (rule R2)', async () => {
		const refused = ctx([
			'connect',
			'--server',
			'https://board.test',
			'--org',
			'arbenger',
			'--project',
			'AFB',
			'HAPR'
		]);
		expect(await checkMain(refused.c)).toBe(2);
		expect(refused.logs.join(' ')).toMatch(/extra word "HAPR"/);
		const lowercase = ctx([
			'connect',
			'--server',
			'https://board.test',
			'--org',
			'arbenger',
			'--project',
			'afb'
		]);
		expect(await checkMain(lowercase.c)).toBe(2);
		expect(lowercase.logs.join(' ')).toMatch(/not "afb"/);
		// The final list is printed before the connection is attempted
		const comma = ctx([
			'connect',
			'--server',
			'https://board.test',
			'--org',
			'arbenger',
			'--project',
			'AFB,HAPR'
		]);
		await checkMain(comma.c);
		expect(comma.logs.join(' ')).toMatch(/Connecting for the projects: AFB, HAPR\./);
	});

	it('run without a connection says how to connect, as one JSON error with --json, and does not wait', async () => {
		const { c, outs } = ctx([
			'run',
			'AFB-20261108-0827',
			'M1',
			'--server',
			'https://board.test',
			'--org',
			'arbenger',
			'--json'
		]);
		expect(await checkMain(c)).toBe(2);
		const e = JSON.parse(outs[0]);
		expect(e).toMatchObject({ ok: false, event: 'error' });
		expect(e.error).toMatch(/check connect/);
	});

	it('run refuses an item reference that is not a plain name', async () => {
		const { c, logs } = ctx([
			'run',
			'../x',
			'M1',
			'--server',
			'https://board.test',
			'--org',
			'arbenger'
		]);
		expect(await checkMain(c)).toBe(2);
		expect(logs.join(' ')).toMatch(/connected|plain name/);
	});

	it('pull shows the board script as data, writes nothing, and writes exactly that text only for its own hash', async () => {
		const script = 'export default async ({ page }) => { await page.goto("/"); };\n';
		const hash = createHash('sha256').update(script).digest('hex');
		const base = ctx([]);
		const run = (extra: string[]) => {
			const c = ctx([
				'pull',
				'AFB-20261108-0827',
				'M1',
				'--server',
				'https://board.test',
				'--org',
				'arbenger',
				...extra
			]);
			c.c.personalToken = () => 'afp_person';
			c.c.fetch = async () => Response.json({ checks: [{ key: 'M1', script }] });
			return c;
		};
		void base;
		const shown = run([]);
		expect(await checkMain(shown.c)).toBe(0);
		const data = JSON.parse(shown.outs[0]);
		expect(data).toMatchObject({ hash, local: 'none', script });
		expect(existsSync(data.target)).toBe(false);
		// A wrong hash writes nothing and says so
		const wrong = run(['--accept-hash', 'f'.repeat(64)]);
		expect(await checkMain(wrong.c)).toBe(2);
		expect(existsSync(data.target)).toBe(false);
		// The right hash writes the exact text, inside the scripts folder
		const right = run(['--accept-hash', hash]);
		expect(await checkMain(right.c)).toBe(0);
		expect(readFileSync(data.target, 'utf8')).toBe(script);
		expect(data.target.startsWith(join(home, 'checks', 'scripts'))).toBe(true);
	});

	it('does not read a terminal anywhere in the check code (each way of reading one has its own short list of files)', () => {
		const dir = join(__dirname);
		// child.ts reads its one job from a pipe the parent writes, never from a person. login.ts holds the owner's headed sign in (the one allowed
		// terminal read, refused without a terminal). approve.ts and commands.ts only ASK whether there is a terminal, to refuse minting a code without one
		const rules: { what: string; re: RegExp; allowed: string[] }[] = [
			{ what: 'isTTY', re: /isTTY/, allowed: ['approve.ts', 'commands.ts', 'login.ts'] },
			{ what: 'readline', re: /node:readline|createInterface/, allowed: ['login.ts'] },
			{ what: 'process.stdin', re: /process\.stdin/, allowed: ['child.ts', 'login.ts'] },
			{ what: 'prompt()', re: /\bprompt\(/, allowed: [] }
		];
		for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
			const text = readFileSync(join(dir, f), 'utf8');
			for (const r of rules)
				if (!r.allowed.includes(f)) expect(text, `${f} must not use ${r.what}`).not.toMatch(r.re);
		}
	});

	it('a flag takes a real value: another flag in its place is refused, not read as the value (C17)', async () => {
		const noServer = ctx(['run', 'AFB-20261108-0827', 'M1', '--server', '--org', 'arbenger']);
		expect(await checkMain(noServer.c)).toBe(2);
		expect(noServer.logs.join(' ')).toMatch(/Say --server <value>/);
		// Any other flag the same way
		const noDir = ctx(['bind', '--org', 'arbenger', '--project', 'AFB', '--dir', '--json']);
		expect(await checkMain(noDir.c)).toBe(2);
		expect(noDir.outs.join(' ')).toMatch(/Say --dir <value>/);
	});

	it('--file must be a script of the organisation --org names (C17)', async () => {
		const file = join(home, 'checks', 'scripts', 'otherorg', 'AFB-20261108-0827', 'M1.mjs');
		const { c, logs } = ctx([
			'run',
			'--file',
			file,
			'--server',
			'https://board.test',
			'--org',
			'arbenger'
		]);
		expect(await checkMain(c)).toBe(2);
		expect(logs.join(' ')).toMatch(/script of the organisation otherorg, but --org says arbenger/);
	});

	it('is loaded only by the check command: the hook and the MCP forwarder never import it', () => {
		const cli = readFileSync(join(__dirname, '..', 'cli.ts'), 'utf8');
		expect(cli).not.toMatch(/^import .*['"]\.\/checks\//m);
		expect(cli).toMatch(/await import\('\.\/checks\/command\.js'\)/);
	});
});
