// THE SETUP COMMAND (AFB-20261108-0427, B.3 AND B.4): THE CLAUDE HOOKS GO INTO A REPO'S SETTINGS FILE, MERGED, BACKED UP OUTSIDE THE REPO AND SAFE TO RUN TWICE
// Each rule has a negative control, so a test cannot pass on a command that writes nothing.

// IMPORTED DEP-MODULES
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { planSetup, runSetup } from './hooks/setup.js';

// -- CONSTANTS -- //

const SERVER = 'https://afb.example.com';
const OTHER_HOOK = { type: 'command', command: 'node ./scripts/lint-on-edit.mjs', timeout: 5 };

// -- FUNCTIONS -- //

type Parsed = {
	hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
} & Record<string, unknown>;
const commands = (settings: Parsed, event: string) =>
	settings.hooks[event].flatMap((e) => e.hooks.map((h) => h.command));

describe('the setup plan', () => {
	it('builds all six Claude hooks with the server and the organisation for a repo with no settings', () => {
		const plan = planSetup(null, SERVER, 'arbenger');
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const settings = JSON.parse(plan.text) as Parsed;
		expect(Object.keys(settings.hooks).sort()).toEqual(
			['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort()
		);
		for (const event of Object.keys(settings.hooks))
			expect(commands(settings, event)).toEqual([
				`agent-flow-board hook claude --server ${SERVER} --org arbenger`
			]);
		expect(plan).toMatchObject({ added: 6, replaced: 0, kept: 0, changed: true });
	});

	it('keeps other hooks and other keys exactly, and puts the bridge hooks after them', () => {
		const existing = JSON.stringify({
			permissions: { allow: ['Bash(yarn test)'] },
			hooks: {
				PostToolUse: [{ matcher: 'Edit', hooks: [OTHER_HOOK] }],
				Notification: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }]
			}
		});
		const plan = planSetup(existing, SERVER, 'arbenger');
		if (!plan.ok) throw new Error(plan.error);
		const settings = JSON.parse(plan.text) as Parsed;
		expect(settings.permissions).toEqual({ allow: ['Bash(yarn test)'] });
		expect(settings.hooks.Notification).toEqual([
			{ hooks: [{ type: 'command', command: 'notify-send done' }] }
		]);
		expect(commands(settings, 'PostToolUse')).toEqual([
			OTHER_HOOK.command,
			`agent-flow-board hook claude --server ${SERVER} --org arbenger`
		]);
		// Two of the other entries stay: the lint hook and the notification
		expect(plan).toMatchObject({ kept: 2, added: 6 });
	});

	it('is safe to run twice: the second run changes nothing', () => {
		const first = planSetup('{"model":"opus"}', SERVER, 'arbenger');
		if (!first.ok) throw new Error(first.error);
		const second = planSetup(first.text, SERVER, 'arbenger');
		if (!second.ok) throw new Error(second.error);
		expect(second.changed).toBe(false);
		expect(second.text).toBe(first.text);
		expect(second).toMatchObject({ added: 0, replaced: 0 });
		// Negative control: the first run did change
		expect(first.changed).toBe(true);
	});

	it('replaces the bridge hooks of another organisation, and never leaves two of them', () => {
		const first = planSetup(null, SERVER, 'arbenger');
		if (!first.ok) throw new Error(first.error);
		const moved = planSetup(first.text, SERVER, 'mangoman');
		if (!moved.ok) throw new Error(moved.error);
		const settings = JSON.parse(moved.text) as Parsed;
		for (const event of Object.keys(settings.hooks)) {
			const mine = commands(settings, event).filter((c) => c.includes('agent-flow-board hook'));
			expect(mine).toEqual([`agent-flow-board hook claude --server ${SERVER} --org mangoman`]);
		}
		expect(moved).toMatchObject({ changed: true, replaced: 6, added: 0 });
		// A hook of the bridge written by hand with another path or flags is found and replaced too
		const hand = JSON.stringify({
			hooks: {
				Stop: [
					{
						hooks: [
							{
								type: 'command',
								command: '/usr/local/bin/agent-flow-board hook claude',
								timeout: 20
							}
						]
					}
				]
			}
		});
		const merged = planSetup(hand, SERVER, 'arbenger');
		if (!merged.ok) throw new Error(merged.error);
		expect(commands(JSON.parse(merged.text) as Parsed, 'Stop')).toHaveLength(1);
	});

	it('refuses a file that is not plain JSON, and a hooks key of the wrong kind, and writes nothing for them', () => {
		for (const bad of ['{ // a comment\n "a": 1 }', '{"a": 1,}', '[]', '"text"', '{"hooks": []}']) {
			const plan = planSetup(bad, SERVER, 'arbenger');
			expect(plan.ok, bad).toBe(false);
		}
		// An empty file is fine: it is the same as none
		expect(planSetup('', SERVER, 'arbenger').ok).toBe(true);
	});
});

describe('the setup command on a repo folder', () => {
	let root: string;
	let home: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'afb-setup-'));
		home = join(root, 'bridge-home');
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const repo = (name: string) => {
		const dir = join(root, name);
		mkdirSync(join(dir, '.claude'), { recursive: true });
		return dir;
	};

	it('writes settings.local.json, leaves the shared settings.json alone, and backs the old file up outside the repo', () => {
		const dir = repo('with-old');
		const shared = join(dir, '.claude', 'settings.json');
		const local = join(dir, '.claude', 'settings.local.json');
		writeFileSync(shared, '{"team":"settings"}');
		writeFileSync(local, JSON.stringify({ hooks: { PostToolUse: [{ hooks: [OTHER_HOOK] }] } }));
		const result = runSetup({ repo: dir, server: SERVER, org: 'arbenger', configDir: home });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result).toMatchObject({ changed: true, file: local });
		expect(readFileSync(shared, 'utf8')).toBe('{"team":"settings"}');
		// The backup holds the old text, and it is not in the repo
		expect(result.backup).not.toBeNull();
		expect(readFileSync(result.backup!, 'utf8')).toContain('lint-on-edit');
		expect(result.backup!.startsWith(dir)).toBe(false);
		expect(readdirSync(join(dir, '.claude')).sort()).toEqual([
			'settings.json',
			'settings.local.json'
		]);
		// Negative control: the other hook is still in the new file
		expect(readFileSync(local, 'utf8')).toContain('lint-on-edit');
	});

	it('writes the shared settings.json only when asked, and makes the folder when there is none', () => {
		const dir = join(root, 'fresh-repo');
		const result = runSetup({
			repo: dir,
			server: SERVER,
			org: 'arbenger',
			shared: true,
			configDir: home
		});
		expect(result).toMatchObject({ ok: true, changed: true, backup: null });
		expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);
		expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(false);
	});

	it('a second run reports no change and writes no backup', () => {
		const dir = repo('twice');
		runSetup({ repo: dir, server: SERVER, org: 'arbenger', configDir: home });
		const again = runSetup({ repo: dir, server: SERVER, org: 'arbenger', configDir: home });
		expect(again).toMatchObject({ ok: true, changed: false, backup: null });
		expect(readdirSync(join(dir, '.claude'))).toEqual(['settings.local.json']);
	});

	it('fails loudly on a file it cannot read as JSON, and leaves it as it was', () => {
		const dir = repo('broken');
		const local = join(dir, '.claude', 'settings.local.json');
		writeFileSync(local, '{ // not json\n}');
		const result = runSetup({ repo: dir, server: SERVER, org: 'arbenger', configDir: home });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/not plain JSON/);
		expect(readFileSync(local, 'utf8')).toBe('{ // not json\n}');
	});
});

describe('the Codex hooks', () => {
	let root: string;
	let home: string;
	let person: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'afb-codex-'));
		home = join(root, 'bridge-home');
		person = join(root, 'person-home');
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const repo = (name: string) => {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		return dir;
	};
	const codex = (dir: string, extra: Record<string, unknown> = {}) =>
		runSetup({
			repo: dir,
			server: SERVER,
			org: 'arbenger',
			tool: 'codex',
			home: person,
			onPath: true,
			configDir: home,
			...extra
		});
	const written = (dir: string) => readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8');

	it('builds the six Codex hooks, each with a timeout, and SessionEnd inside the three seconds Codex gives it', () => {
		const plan = planSetup(null, SERVER, 'arbenger', 'codex');
		if (!plan.ok) throw new Error(plan.error);
		const parsed = JSON.parse(plan.text) as {
			hooks: Record<string, { matcher?: string; hooks: { command: string; timeout?: number }[] }[]>;
		};
		expect(Object.keys(parsed.hooks).sort()).toEqual(
			['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort()
		);
		for (const entries of Object.values(parsed.hooks))
			for (const e of entries)
				for (const h of e.hooks) {
					expect(h.command).toBe(`agent-flow-board hook codex --server ${SERVER} --org arbenger`);
					expect(typeof h.timeout).toBe('number');
				}
		expect(parsed.hooks.SessionEnd[0].hooks[0].timeout).toBeLessThanOrEqual(3);
		// The matchers are valid regular expressions and name the tools the adapter reads
		const post = new RegExp(parsed.hooks.PostToolUse[0].matcher!);
		for (const name of ['apply_patch', 'Bash', 'exec_command', 'mcp__afb-arbenger__step_done'])
			expect(post.test(name), name).toBe(true);
		expect(post.test('mcp__filesystem__read_file')).toBe(false);
		expect(JSON.stringify(parsed)).not.toContain('command_windows');
	});

	it('writes the repo file by default, keeps other hooks, backs up outside the repo and runs twice to the same file', () => {
		const dir = repo('one');
		mkdirSync(join(dir, '.codex'));
		writeFileSync(
			join(dir, '.codex', 'hooks.json'),
			JSON.stringify({ hooks: { PostToolUse: [{ hooks: [OTHER_HOOK] }] } })
		);
		const first = codex(dir);
		expect(first).toMatchObject({ ok: true, changed: true, warnings: [] });
		if (!first.ok) return;
		expect(first.file).toBe(join(dir, '.codex', 'hooks.json'));
		expect(first.backup!.startsWith(dir)).toBe(false);
		expect(written(dir)).toContain('lint-on-edit');
		expect(written(dir)).toContain('hook codex');
		const text = written(dir);
		expect(codex(dir)).toMatchObject({ ok: true, changed: false, backup: null });
		expect(written(dir)).toBe(text);
	});

	it('a Codex run keeps the Claude bridge hooks of a shared file, and a Claude run keeps the Codex ones', () => {
		const withClaude = planSetup(null, SERVER, 'arbenger', 'claude');
		if (!withClaude.ok) throw new Error(withClaude.error);
		const both = planSetup(withClaude.text, SERVER, 'arbenger', 'codex');
		if (!both.ok) throw new Error(both.error);
		expect(both.text).toContain('hook claude');
		expect(both.text).toContain('hook codex');
		expect(both).toMatchObject({ added: 6, kept: 6 });
		const back = planSetup(both.text, SERVER, 'arbenger', 'claude');
		if (!back.ok) throw new Error(back.error);
		expect(back.text).toContain('hook codex');
		expect(back.changed).toBe(false);
	});

	it('--global writes the person file, says it fixes one organisation, and warns when both files hold the hooks', () => {
		const dir = repo('two');
		const global = codex(dir, { global: true });
		expect(global).toMatchObject({ ok: true, file: join(person, '.codex', 'hooks.json') });
		if (!global.ok) return;
		expect(global.warnings.join(' ')).toMatch(/every Codex project/);
		// The repo file now makes the same hooks run twice, and the run says so
		const repoRun = codex(dir);
		if (!repoRun.ok) throw new Error(repoRun.error);
		expect(repoRun.warnings.join(' ')).toMatch(/sent twice/);
	});

	it('warns when the program is not on the PATH', () => {
		const result = codex(repo('three'), { onPath: false });
		if (!result.ok) throw new Error(result.error);
		expect(result.warnings.join(' ')).toMatch(/not found on the PATH/);
	});

	it('refuses an address that could carry a second command, and writes nothing', () => {
		for (const bad of [
			'https://afb.example.com; rm -rf x',
			'https://afb.example.com" & calc',
			'https://user:pass@afb.example.com',
			'ftp://afb.example.com',
			'https://afb example.com'
		]) {
			const dir = repo('bad');
			const result = runSetup({
				repo: dir,
				server: bad,
				org: 'arbenger',
				tool: 'codex',
				home: person,
				configDir: home
			});
			expect(result.ok, bad).toBe(false);
			expect(existsSync(join(dir, '.codex')), bad).toBe(false);
		}
		expect(planSetup(null, 'http://localhost:5190', 'arbenger', 'codex').ok).toBe(true);
	});

	it('reads a file that starts with a byte order mark, and refuses one that is not JSON, leaving it as it was', () => {
		const dir = repo('bom');
		mkdirSync(join(dir, '.codex'));
		writeFileSync(join(dir, '.codex', 'hooks.json'), '\uFEFF{"hooks":{}}');
		expect(codex(dir)).toMatchObject({ ok: true, changed: true });
		const broken = repo('broken-codex');
		mkdirSync(join(broken, '.codex'));
		writeFileSync(join(broken, '.codex', 'hooks.json'), '{ // not json\n}');
		const result = codex(broken);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/hooks print codex/);
		expect(written(broken)).toBe('{ // not json\n}');
	});

	it('writes through a linked file, so the link stays', () => {
		const dir = repo('linked');
		const real = join(root, 'dotfiles-hooks.json');
		writeFileSync(real, '{"hooks":{}}');
		mkdirSync(join(dir, '.codex'));
		const link = join(dir, '.codex', 'hooks.json');
		try {
			symlinkSync(real, link);
		} catch {
			// Creating a link needs a permission some Windows accounts do not have: nothing to prove there
			return;
		}
		expect(codex(dir)).toMatchObject({ ok: true, changed: true });
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(real, 'utf8')).toContain('hook codex');
	});
});
