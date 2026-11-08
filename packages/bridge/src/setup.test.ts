// THE SETUP COMMAND (AFB-20261108-0427, B.3 AND B.4): THE CLAUDE HOOKS GO INTO A REPO'S SETTINGS FILE, MERGED, BACKED UP OUTSIDE THE REPO AND SAFE TO RUN TWICE
// Each rule has a negative control, so a test cannot pass on a command that writes nothing.

// -- DEP-MODULES -- //
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// -- MODULES -- //
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
