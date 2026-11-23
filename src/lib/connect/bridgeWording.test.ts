// THE WORDS OF THE CONNECT PAGE AND THE DEVICE PAGE MUST BE THE WORDS THE TERMINAL PRINTS (AFB-20261115-1229). The page and the bridge are read as text, so a change on one side that the other does not follow fails here.

// IMPORTED DEP-MODULES
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { bridgeCommands } from './bridgeCommands';
import { BRIDGE_PACKAGE, BRIDGE_PROGRAM } from './bridgeInstall';

// -- CONSTANTS -- //

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), 'utf8');

// -- FUNCTIONS -- //

describe('the pages say what the terminal says', () => {
	it('the device page says "The code works for N minutes" like the terminal, and says it works once', () => {
		const terminal = read('packages', 'bridge', 'src', 'device.ts');
		const page = read('src', 'routes', 'device', '+page.svelte');
		expect(terminal).toContain('The code works for');
		expect(page).toContain('The code works for');
		expect(page).toMatch(/works once/);
		// The terminal tells the person where to type the code: the page is that place
		expect(terminal).toMatch(/open \$\{d\.verification_uri\} and type this code/);
	});

	it('every command on the Connect page starts with a word the bridge usage lists, and none is a removed check command', () => {
		const usage = read('packages', 'bridge', 'src', 'cli.ts');
		const list = bridgeCommands('https://board.test', 'acme');
		expect(list.length).toBeGreaterThan(5);
		for (const c of list) {
			const first = c.command.slice(BRIDGE_PROGRAM.length + 1).split(' ')[0];
			expect(usage, c.command).toContain(`agent-flow-board ${first}`);
			expect(first, c.command).not.toBe('check');
		}
	});

	it('the bridge is installed by its npm package name', () => {
		expect(BRIDGE_PACKAGE).toBe('@agent-flow-board/bridge');
		expect(read('packages', 'bridge', 'README.md')).toContain(`npm install -g ${BRIDGE_PACKAGE}`);
	});
});
