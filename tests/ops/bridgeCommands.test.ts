// THE BRIDGE COMMAND LIST OF THE CONNECT PAGE (AFB-20261115-1000, G.5): EVERY COMMAND IT NAMES EXISTS IN THE BRIDGE

// IMPORTED DEP-MODULES
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	COMMAND_KINDS,
	bridgeCommands,
	commandWords,
	filterCommands
} from '../../src/lib/connect/bridgeCommands';

// -- CONSTANTS -- //

const BRIDGE = join(__dirname, '..', '..', 'packages', 'bridge');
// What the bridge itself says about its commands: the README and the usage lines of the program
const SAID = `${readFileSync(join(BRIDGE, 'README.md'), 'utf8')}\n${readFileSync(join(BRIDGE, 'src', 'cli.ts'), 'utf8')}`;
const ALL = bridgeCommands('https://board.example.com', 'acme');

// -- FUNCTIONS -- //

describe('the bridge commands of the Connect page', () => {
	it('fill in the board address and the organisation and leave no placeholder of the page behind', () => {
		for (const c of ALL) expect(c.command, c.command).not.toMatch(/\{server\}|\{org\}/);
		expect(ALL[0].command).toBe(
			'agent-flow-board login --server https://board.example.com --org acme'
		);
		expect(ALL.some((c) => c.command.includes('--org acme'))).toBe(true);
	});

	it('name only words the bridge itself uses (a renamed command fails here)', () => {
		for (const c of ALL)
			for (const word of commandWords(c)) expect(SAID, `${c.command}: ${word}`).toContain(word);
	});

	it('hold the commands a person was told about: mockups, held writes, hooks and stdio, and no browser check command', () => {
		const joined = ALL.map((c) => c.command).join('\n');
		expect(joined).not.toMatch(/agent-flow-board check /);
		for (const expected of [
			'mockup push',
			'queue list',
			'hooks print',
			'hooks setup codex',
			' mcp --server'
		])
			expect(joined, expected).toContain(expected);
	});

	it('put every command in a kind the page filters by, and use each kind', () => {
		for (const c of ALL) expect(COMMAND_KINDS, c.command).toContain(c.kind);
		for (const k of COMMAND_KINDS)
			expect(
				ALL.some((c) => c.kind === k),
				k
			).toBe(true);
	});

	it('are each different, so a list keyed by the command never meets a repeat', () => {
		const seen = new Set(ALL.map((c) => c.command));
		expect(seen.size).toBe(ALL.length);
	});

	it('carry no secret', () => {
		expect(ALL.map((c) => c.command).join('\n')).not.toMatch(/afb_[A-Za-z0-9]{10,}|Bearer /);
	});
	it('filters by kind and by a word, grouped in the usual order, and finds nothing for a word that is not there', () => {
		expect(filterCommands(ALL, 'All', '').map((g) => g.kind)).toEqual([...COMMAND_KINDS]);
		const mockups = filterCommands(ALL, 'Mockups', '');
		expect(mockups).toHaveLength(1);
		expect(mockups[0].rows.every((c) => c.kind === 'Mockups')).toBe(true);
		const pushes = filterCommands(ALL, 'All', 'PUSH');
		expect(pushes.flatMap((g) => g.rows).map((c) => c.command)).toEqual([
			'agent-flow-board mockup push <file.html> --server https://board.example.com --org acme --item <ref>'
		]);
		expect(filterCommands(ALL, 'Hooks', 'push')).toEqual([]);
		expect(filterCommands(ALL, 'All', 'no such word anywhere')).toEqual([]);
	});
});
