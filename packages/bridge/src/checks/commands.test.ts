// TESTS OF THE HANDLERS OF `check project`, `check approve` AND `check roots`: EXIT CODES AND WHAT THEY PRINT.

// -- DEP-MODULES -- //
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import { approveCommand, projectCommand, rootsCommand } from './commands.js';

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
});
