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

	it('the commands on the Connect page are the ones the bridge usage lists, with the yes for the download', () => {
		const usage = read('packages', 'bridge', 'src', 'checks', 'command.ts');
		const list = bridgeCommands('https://board.test', 'acme').map((c) => c.command);
		expect(list).toContain(`${BRIDGE_PROGRAM} check doctor`);
		expect(list).toContain(`${BRIDGE_PROGRAM} check doctor --fix --yes`);
		expect(list).toContain(`${BRIDGE_PROGRAM} check setup --yes`);
		expect(usage).toContain('doctor [--fix] [--yes] [--json]');
		expect(usage).toContain('setup [--yes]');
	});

	it('the Remove it card names only the bridge’s own folders and existing commands', () => {
		const card = read('src', 'lib', 'board', 'connect', 'BridgeHealthCard.svelte');
		expect(card).toContain('check disconnect --server');
		expect(card).toContain('check service uninstall');
		expect(card).toContain(`npm uninstall -g \${BRIDGE_PACKAGE}`);
		expect(BRIDGE_PACKAGE).toBe('@agent-flow-board/bridge');
		// No line may reach outside checks/browsers and checks/runtime
		for (const line of card.split('\n').filter((l) => /Remove-Item|rm -rf/.test(l))) {
			expect(line).toMatch(/checks[\\/]+(browsers|runtime)/);
			expect(line).not.toMatch(/ms-playwright|\s\/\s|~\/\s|\$HOME\\"\s/);
		}
		const bridgeUsage = read('packages', 'bridge', 'src', 'checks', 'command.ts');
		expect(bridgeUsage).toContain('disconnect --server <url> --org <slug>');
		expect(bridgeUsage).toContain('service install|uninstall|status');
	});

	it('the browser download is described the same on the page, in the README and by the bridge', () => {
		const browser = read('packages', 'bridge', 'src', 'checks', 'browser.ts');
		const card = read('src', 'lib', 'board', 'connect', 'BridgeHealthCard.svelte');
		const readme = read('packages', 'bridge', 'README.md');
		for (const text of [browser, card, readme]) expect(text).toMatch(/320 MB/);
	});
});
