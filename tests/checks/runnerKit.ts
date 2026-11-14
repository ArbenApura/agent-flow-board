// SHARED BY THE RUNNER AND UI SHOTS CHECKS: START THE REAL RUNNER PROGRAM FOR ONE PASS OVER THE QUEUE

// IMPORTED DEP-MODULES
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// -- FUNCTIONS -- //

/** Starts the runner program for one pass over the queue and waits for it to stop. */
export function runRunner(base: string, token: string, extra: string[] = [], state?: string) {
	return new Promise<{ code: number | null; out: string }>((resolve) => {
		const child = spawn(
			process.execPath,
			[
				'--import',
				'tsx',
				'packages/runner/src/cli.ts',
				'start',
				'--server',
				base,
				'--token',
				token,
				'--once',
				// The preview server of these checks is the build of this working tree
				'--trust-running',
				'--interval',
				'300',
				'--state',
				state ?? mkdtempSync(join(tmpdir(), 'afb-state-')),
				...extra
			],
			{ cwd: process.cwd(), env: { ...process.env, AFB_RUNNER_TOKEN: '' } }
		);
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		child.on('close', (code) => resolve({ code, out }));
	});
}
