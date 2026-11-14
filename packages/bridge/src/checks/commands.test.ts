// TESTS OF THE HANDLERS OF `check project`, `check approve` AND `check roots`: EXIT CODES AND WHAT THEY PRINT.

// IMPORTED DEP-MODULES
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { approveCommand, projectCommand, rootsCommand } from './commands.js';
import { devApprovalTarget, devConfigHash } from './devPolicy.js';
import { readRegistrations } from './registry.js';

// -- FUNCTIONS -- //

describe('commands', () => {
	let base = '';
	let work = '';
	let saved: string | undefined;
	let out: string[] = [];
	let log: string[] = [];
	const ctx = (json = false) => ({
		json,
		out: (l: string) => out.push(l),
		log: (l: string) => log.push(l)
	});
	const codeOf = () => /: ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})$/m.exec(out.join('\n'))?.[1] ?? '';

	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-commands-')));
		saved = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
		work = join(base, 'work');
		mkdirSync(join(work, 'app', '.git'), { recursive: true });
		work = realpathSync.native(work);
		writeFileSync(
			join(work, 'app', 'package.json'),
			JSON.stringify({ scripts: { preview: 'vite preview' } })
		);
		out = [];
		log = [];
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = saved;
		rmSync(base, { recursive: true, force: true });
	});

	it('approve refuses without a terminal and makes a code with one', async () => {
		expect(
			await approveCommand(['--action', 'roots', '--target', work], ctx(), { isTTY: false })
		).toBe(1);
		expect(log.join(' ')).toMatch(/interactive terminal/);
		expect(
			await approveCommand(['--action', 'bogus', '--target', 'x'], ctx(), { isTTY: true })
		).toBe(2);
		expect(await approveCommand(['--action', 'roots'], ctx(), { isTTY: true })).toBe(2);
		out = [];
		expect(
			await approveCommand(['--action', 'roots', '--target', work], ctx(), { isTTY: true })
		).toBe(0);
		expect(codeOf()).toBeTruthy();
	});
	it('approve --many makes several codes at once and only with a terminal', async () => {
		const many = `roots:${work};register:HAPRA@app.example.com`;
		expect(await approveCommand(['--many', many], ctx(), { isTTY: false })).toBe(1);
		expect(log.join(' ')).toMatch(/interactive terminal/);
		expect(await approveCommand(['--many', 'bogus:x'], ctx(), { isTTY: true })).toBe(2);
		expect(await approveCommand(['--many', 'roots:'], ctx(), { isTTY: true })).toBe(2);
		expect(
			await approveCommand(['--many', many, '--action', 'roots'], ctx(), { isTTY: true })
		).toBe(2);
		out = [];
		expect(await approveCommand(['--many', many], ctx(), { isTTY: true })).toBe(0);
		expect(out.filter((l) => /: [A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(l))).toHaveLength(2);
		// The first code works for its own folder, once
		const first = /: ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})$/m.exec(out[0] ?? '')?.[1] ?? '';
		expect(await rootsCommand(['add', work, '--approval', first], ctx())).toBe(0);
	});
	it('walks through roots, project, list, pin and forget', async () => {
		expect(await rootsCommand(['add', work], ctx())).toBe(1);
		await approveCommand(['--action', 'roots', '--target', work], ctx(), { isTTY: true });
		expect(await rootsCommand(['add', work, '--approval', codeOf()], ctx())).toBe(0);
		out = [];
		expect(await rootsCommand(['list'], ctx())).toBe(0);
		expect(out).toEqual([work]);

		const repo = join(work, 'app');
		expect(await projectCommand(['AFB', '--org', 'acme', '--repo', repo], ctx())).toBe(0);
		expect(await projectCommand(['AFB', '--repo', repo], ctx())).toBe(2);
		expect(await projectCommand(['AFB2', '--org', 'acme', '--repo', repo], ctx())).toBe(1);
		out = [];
		expect(await projectCommand(['list', '--org', 'acme'], ctx(true))).toBe(0);
		const listed = JSON.parse(out[0] ?? '{}') as { registrations: { name: string; pin: string }[] };
		expect(listed.registrations).toMatchObject([{ name: 'AFB', pin: 'unpinned' }]);
		out = [];
		expect(await projectCommand(['pin', 'AFB', '--org', 'acme'], ctx())).toBe(0);
		expect(out.join(' ')).toMatch(/Pinned AFB/);
		expect(await projectCommand(['forget', 'AFB', '--org', 'acme', '--remove'], ctx())).toBe(0);
		expect(await projectCommand(['forget', 'AFB', '--org', 'acme'], ctx())).toBe(1);
	});
	it('says what is missing instead of guessing', async () => {
		expect(await projectCommand([], ctx())).toBe(2);
		expect(await projectCommand(['AFB', '--org'], ctx())).toBe(2);
		expect(await rootsCommand(['add'], ctx())).toBe(2);
		expect(await rootsCommand(['bogus', 'x'], ctx())).toBe(2);
	});
	it('registers a --dev-url project with --start and --board-project, listed as dev', async () => {
		const hash = devConfigHash({
			devUrl: 'http://localhost:5173',
			startCommand: ['node', 'server.js']
		});
		out = [];
		await approveCommand(
			['--action', 'dev', '--target', devApprovalTarget('WEBDEV', hash)],
			ctx(),
			{ isTTY: true }
		);
		const code = codeOf();
		out = [];
		const status = await projectCommand(
			[
				'WEBDEV',
				'--org',
				'acme',
				'--dev-url',
				'http://localhost:5173',
				'--start',
				'node server.js',
				'--board-project',
				'PROJ1',
				'--approval',
				code
			],
			ctx(true)
		);
		expect(status).toBe(0);
		expect(JSON.parse(out.join(''))).toMatchObject({
			org: 'acme',
			name: 'WEBDEV',
			boardProject: 'PROJ1',
			devUrl: 'http://localhost:5173'
		});
		out = [];
		expect(await projectCommand(['list', '--org', 'acme'], ctx(true))).toBe(0);
		const listed = JSON.parse(out[0] ?? '{}') as {
			registrations: { name: string; boardProject: string; kind: string; devUrl?: string | null }[];
		};
		expect(listed.registrations).toMatchObject([
			{
				org: 'acme',
				name: 'WEBDEV',
				boardProject: 'PROJ1',
				kind: 'dev',
				devUrl: 'http://localhost:5173'
			}
		]);

		out = [];
		expect(await projectCommand(['list', '--org', 'acme'], ctx(false))).toBe(0);
		expect(out.join('\n')).toContain('http://localhost:5173');
		expect(out.join('\n')).not.toContain('null');

		// Boolean `--allow-writes` parses cleanly with `--write-allowlist`
		const wHash = devConfigHash({
			devUrl: 'http://127.0.0.1:4173',
			startCommand: ['node', 'server.js'],
			allowWrites: true,
			writeAllowlist: [{ method: 'POST', pathPrefix: '/api/drafts' }]
		});
		out = [];
		expect(
			await approveCommand(
				['--action', 'dev', '--target', devApprovalTarget('WRITEDEV', wHash)],
				ctx(false),
				{ isTTY: true }
			)
		).toBe(0);
		const wCode = codeOf();
		expect(
			await projectCommand(
				[
					'WRITEDEV',
					'--org',
					'acme',
					'--dev-url',
					'http://127.0.0.1:4173',
					'--start',
					'node server.js',
					'--allow-writes',
					'--write-allowlist',
					'POST /api/drafts',
					'--approval',
					wCode
				],
				ctx(true)
			)
		).toBe(0);
	});

	it('keeps --write-allowlist rules whole and prints --extra-hosts before acting (rule R2)', async () => {
		const repo = join(work, 'app');
		await approveCommand(['--action', 'roots', '--target', work], ctx(), { isTTY: true });
		expect(await rootsCommand(['add', work, '--approval', codeOf()], ctx())).toBe(0);
		// 'POST /api,DELETE /x' in one quoted word stays exactly two rules
		const twoHash = devConfigHash({
			devUrl: 'http://127.0.0.1:4173',
			startCommand: ['node', 'server.js'],
			allowWrites: true,
			writeAllowlist: [
				{ method: 'POST', pathPrefix: '/api' },
				{ method: 'DELETE', pathPrefix: '/x' }
			]
		});
		out = [];
		const approveStatus = await approveCommand(
			['--action', 'dev', '--target', devApprovalTarget('TWOALWD', twoHash)],
			ctx(),
			{ isTTY: true }
		);
		expect(approveStatus).toBe(0);
		const twoCode = codeOf();
		const status = await projectCommand(
			[
				'TWOALWD',
				'--org',
				'acme',
				'--dev-url',
				'http://127.0.0.1:4173',
				'--start',
				'node server.js',
				'--allow-writes',
				'--write-allowlist',
				'POST /api,DELETE /x',
				'--approval',
				twoCode
			],
			ctx(true)
		);
		expect(status).toBe(0);
		const { registrations } = readRegistrations('acme');
		expect(
			registrations
				.find((r) => r.name === 'TWOALWD')
				?.writeAllowlist?.map((r) => `${r.method} ${r.pathPrefix}`)
				.sort()
		).toEqual(['DELETE /x', 'POST /api']);

		// A trailing positional after --extra-hosts is never swallowed, and an address is not a host name
		expect(
			await projectCommand(
				['XH', '--org', 'acme', '--repo', repo, '--extra-hosts', 'a.test', 'b.test'],
				ctx()
			)
		).toBe(2);
		expect(
			await projectCommand(
				['XH', '--org', 'acme', '--repo', repo, '--extra-hosts', 'https://a.test'],
				ctx()
			)
		).toBe(2);
		// The final list is printed before the registration
		log = [];
		expect(
			await projectCommand(
				['XH2', '--org', 'acme', '--repo', repo, '--extra-hosts', 'a.test,b.test'],
				ctx()
			)
		).toBe(0);
		expect(log.join(' ')).toMatch(/Extra hosts: a\.test, b\.test\./);
	});
});
