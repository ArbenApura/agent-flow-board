// THE PreToolUse GUARD THAT REFUSES COMMANDS WHICH EMPTY THE LOCAL DOCKER POSTGRES

// IMPORTED DEP-MODULES
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// -- CONSTANTS -- //

const SCRIPT = '.claude/hooks/block-db-reset.mjs';

// -- FUNCTIONS -- //

function runHook(command: string) {
	return spawnSync(process.execPath, [SCRIPT], {
		input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
		encoding: 'utf8'
	});
}

// The hook lives in .claude/, which is gitignored, so a clean checkout (CI) does not have it and these cases only run on a machine that does
describe.skipIf(!existsSync(SCRIPT))('block-db-reset hook', () => {
	it.each([
		'yarn db:local:reset',
		'docker compose down -v',
		'docker-compose down --volumes',
		'docker volume rm afb_pgdata',
		'psql -c "DROP DATABASE afb"'
	])('refuses %s', (command) => {
		const out = runHook(command);
		expect(out.status).toBe(2);
		expect(out.stderr).toContain('Docker PostgreSQL');
	});

	it.each(['yarn db:up', 'docker compose up -d', 'docker compose down', 'yarn vitest run'])(
		'allows %s',
		(command) => {
			expect(runHook(command).status).toBe(0);
		}
	);

	it('ignores a payload that is not JSON', () => {
		const out = spawnSync(process.execPath, [SCRIPT], { input: 'nope', encoding: 'utf8' });
		expect(out.status).toBe(0);
	});
});
