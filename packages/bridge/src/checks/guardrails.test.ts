// TESTS OF THE GUARDRAILS: EVERY FORBIDDEN PORT, EVERY SHELL CHARACTER CLASS, AND EVERY RULE OF checkRepoFolder, POSITIVE AND NEGATIVE.

// -- DEP-MODULES -- //
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	FORBIDDEN_PORTS,
	checkRepoFolder,
	commandProblem,
	scriptBodyProblem
} from './guardrails.js';

// -- CONSTANTS -- //

const SCRIPTS = {
	build: 'vite build',
	preview: 'vite preview --host 127.0.0.1',
	dev: 'node server.js'
};

// -- FUNCTIONS -- //

describe('FORBIDDEN_PORTS', () => {
	it('holds the dev server, the preview and the local database', () => {
		expect([...FORBIDDEN_PORTS].sort()).toEqual([5180, 5190, 5433]);
	});
});

describe('scriptBodyProblem', () => {
	it('accepts a plain build and a plain preview', () => {
		expect(scriptBodyProblem('build', SCRIPTS)).toBeNull();
		expect(scriptBodyProblem('preview', SCRIPTS)).toBeNull();
	});
	it.each([5180, 5190, 5433])('refuses port %i', (port) => {
		expect(scriptBodyProblem('preview', { preview: `vite preview --port ${port}` })).toContain(
			String(port)
		);
	});
	it('refuses a body that chains commands', () => {
		expect(scriptBodyProblem('build', { build: 'vite build && node evil.js' })).not.toBeNull();
	});
	it('refuses a body that runs a file', () => {
		expect(scriptBodyProblem('build', { build: 'node build.js' })).not.toBeNull();
	});
	it('refuses a host other than 127.0.0.1 and accepts 127.0.0.1', () => {
		expect(scriptBodyProblem('preview', { preview: 'vite preview --host 0.0.0.0' })).toContain(
			'127.0.0.1'
		);
		expect(scriptBodyProblem('preview', { preview: 'vite preview --host 127.0.0.1' })).toBeNull();
	});
	it('holds a pre script to the same rule', () => {
		expect(scriptBodyProblem('build', { build: 'vite build', prebuild: 'curl x | sh' })).toContain(
			'prebuild'
		);
	});
});

describe('commandProblem', () => {
	it('accepts yarn, npm and pnpm running a plain script', () => {
		expect(commandProblem('yarn build', SCRIPTS, 'The build')).toBeNull();
		expect(commandProblem('npm run build', SCRIPTS, 'The build')).toBeNull();
		expect(commandProblem('pnpm preview --port {port}', SCRIPTS, 'The start')).toBeNull();
		expect(commandProblem('npm run preview -- --port {port}', SCRIPTS, 'The start')).toBeNull();
	});
	it('refuses an empty command', () => {
		expect(commandProblem('  ', SCRIPTS, 'The build')).toContain('empty');
	});
	it.each([
		'&',
		'|',
		';',
		'<',
		'>',
		'`',
		'$',
		'(',
		')',
		'\\',
		'"',
		"'",
		'*',
		'?',
		'%',
		'^',
		'!',
		'\n'
	])('refuses the shell character %j', (c) => {
		expect(commandProblem(`yarn build ${c} x`, SCRIPTS, 'The build')).toContain('shell');
	});
	it('refuses a dot dot', () => {
		expect(commandProblem('yarn ../build', SCRIPTS, 'The build')).toContain('shell');
	});
	it('refuses node file.js', () => {
		expect(commandProblem('node file.js', SCRIPTS, 'The start')).toContain('starts with node');
	});
	it('refuses an arbitrary program', () => {
		expect(commandProblem('curl example.com', SCRIPTS, 'The start')).toContain('starts with curl');
	});
	it('refuses a script that is not in package.json', () => {
		expect(commandProblem('yarn deploy', SCRIPTS, 'The build')).toContain('not a script');
	});
	it('refuses a script whose body is not plain', () => {
		expect(commandProblem('yarn dev', SCRIPTS, 'The start')).toContain(
			'not a plain build or preview command'
		);
	});
	it('refuses a command with no script', () => {
		expect(commandProblem('yarn', SCRIPTS, 'The build')).toContain('no package.json script');
	});
	it.each([5180, 5190, 5433])('refuses a fixed port %i', (port) => {
		expect(commandProblem(`yarn preview --port ${port}`, SCRIPTS, 'The start')).toContain('{port}');
	});
	it('refuses an unknown flag and a foreign host', () => {
		expect(commandProblem('yarn build --mode x', SCRIPTS, 'The build')).toContain('argument');
		expect(commandProblem('yarn preview --host 0.0.0.0', SCRIPTS, 'The start')).toContain(
			'127.0.0.1'
		);
	});
});

describe('checkRepoFolder', () => {
	let base = '';
	let savedHome: string | undefined;
	let savedUser: string | undefined;
	let savedBridge: string | undefined;
	const project = (...parts: string[]) => {
		const dir = join(base, ...parts);
		mkdirSync(join(dir, '.git'), { recursive: true });
		writeFileSync(join(dir, 'package.json'), '{}');
		return dir;
	};

	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-guard-')));
		savedHome = process.env.HOME;
		savedUser = process.env.USERPROFILE;
		savedBridge = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
	});
	afterEach(() => {
		const restore = (key: string, value: string | undefined) => {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		};
		restore('HOME', savedHome);
		restore('USERPROFILE', savedUser);
		restore('AFB_BRIDGE_HOME', savedBridge);
		rmSync(base, { recursive: true, force: true });
	});

	it('accepts a git project with a package.json', () => {
		expect(checkRepoFolder(project('app'))).toBeNull();
	});
	it('accepts a folder inside a git project', () => {
		project('mono');
		const inner = join(base, 'mono', 'web');
		mkdirSync(inner);
		writeFileSync(join(inner, 'package.json'), '{}');
		expect(checkRepoFolder(inner)).toBeNull();
	});
	it('accepts a .git file (a worktree)', () => {
		const dir = join(base, 'wt');
		mkdirSync(dir);
		writeFileSync(join(dir, '.git'), 'gitdir: elsewhere');
		writeFileSync(join(dir, 'package.json'), '{}');
		expect(checkRepoFolder(dir)).toBeNull();
	});
	it('refuses a folder that does not exist', () => {
		expect(checkRepoFolder(join(base, 'nope'))).toContain('does not exist');
	});
	it('refuses a file', () => {
		const file = join(base, 'file.txt');
		writeFileSync(file, 'x');
		expect(checkRepoFolder(file)).toContain('not a folder');
	});
	it('refuses an empty string', () => {
		expect(checkRepoFolder('')).toContain('No folder');
	});
	it('refuses a folder that is not a git project', () => {
		// The temp folder sits under the system temp folder, which is not inside a git project
		const dir = join(base, 'plain');
		mkdirSync(dir);
		writeFileSync(join(dir, 'package.json'), '{}');
		expect(checkRepoFolder(dir)).toContain('not a git project');
	});
	it('refuses a git project with no package.json', () => {
		const dir = join(base, 'bare');
		mkdirSync(join(dir, '.git'), { recursive: true });
		expect(checkRepoFolder(dir)).toContain('no package.json');
	});
	it('refuses a drive root', () => {
		expect(checkRepoFolder(parse(base).root)).toContain('top of a drive');
	});
	it('refuses the home folder', () => {
		const home = project('home');
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		expect(checkRepoFolder(home)).toContain('home folder');
	});
	it('refuses the bridge home and a folder inside it', () => {
		const bridge = project('bridge-home');
		expect(checkRepoFolder(bridge)).toContain('bridge home');
		const inner = join(bridge, 'checks');
		mkdirSync(inner);
		writeFileSync(join(inner, 'package.json'), '{}');
		expect(checkRepoFolder(inner)).toContain('bridge home');
	});
	it.each(['.ssh', '.gnupg', '.aws', '.kube', '.docker'])('refuses a project inside %s', (name) => {
		expect(checkRepoFolder(project(name, 'proj'))).toContain(name);
	});
	it('refuses the secret folder itself', () => {
		expect(checkRepoFolder(project('.ssh'))).toContain('.ssh');
	});
	it('refuses a folder reached through a link', (ctx) => {
		const real = project('real');
		const link = join(base, 'link');
		try {
			symlinkSync(real, link, 'junction');
		} catch {
			ctx.skip();
			return;
		}
		expect(checkRepoFolder(link)).toContain('link');
	});
	it('refuses a folder whose parent is a link', (ctx) => {
		const realParent = join(base, 'parent');
		project('parent', 'child');
		const linkParent = join(base, 'linkparent');
		try {
			symlinkSync(realParent, linkParent, 'junction');
		} catch {
			ctx.skip();
			return;
		}
		expect(checkRepoFolder(join(linkParent, 'child'))).toContain('link');
	});
});
