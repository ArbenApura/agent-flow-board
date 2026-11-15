import { describe, expect, it } from 'vitest';
import {
	BRIDGE_PACKAGE,
	BRIDGE_PROGRAM,
	INSTALL_COMMAND,
	NODE_REQUIREMENT,
	loginCommand
} from '../../src/lib/connect/bridgeInstall';
import { installPlan } from '../../src/lib/server/editor-status';

describe('the bridge words of the Connect page', () => {
	it('install the package globally', () => {
		expect(INSTALL_COMMAND).toBe('npm install -g @agent-flow-board/bridge');
		expect(INSTALL_COMMAND).toContain(BRIDGE_PACKAGE);
		expect(NODE_REQUIREMENT).toContain('20');
	});
	it('say the same as the first step of the plan an agent is handed', () => {
		const plan = installPlan({ slug: 'acme', server: 'https://board.example.com' });
		const first = plan.steps[0];
		expect(first).toContain(INSTALL_COMMAND);
		expect(first).toContain(`"${BRIDGE_PROGRAM}"`);
		expect(first).toMatch(/Node 20/);
	});
	it('build the plain login command for one organisation', () => {
		expect(loginCommand('https://board.example.com', 'acme')).toBe(
			'agent-flow-board login --server https://board.example.com --org acme'
		);
	});
	it('the login command is the one the bridge README documents', () => {
		const cmd = loginCommand('https://x.example', 'acme');
		expect(cmd.startsWith(`${BRIDGE_PROGRAM} login --server `)).toBe(true);
		expect(cmd).toContain(' --org ');
	});
});
