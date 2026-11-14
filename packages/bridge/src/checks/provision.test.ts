// THE THROWAWAY DATABASE: ONLY THE REFUSALS ARE TESTED, WITH DOCKER STUBBED. NO TEST EVER STARTS A REAL CONTAINER.

// IMPORTED DEP-MODULES
import { describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	checkDockerArgs,
	freePort,
	makeThrowawayDatabase,
	removeContainer,
	type DockerRun
} from './provision.js';
import { FORBIDDEN_PORTS } from './guardrails.js';
import type { RunScopeLike } from './types.js';

// -- FUNCTIONS -- //

const scope = (): RunScopeLike & { added: string[] } => {
	const added: string[] = [];
	return { runId: 'rx', added, add: (n) => void added.push(n), close: async () => {} };
};
const stub =
	(calls: string[][], failVersion = false): DockerRun =>
	async (args) => {
		calls.push(args);
		return { status: failVersion && args[0] === 'version' ? 1 : 0, stdout: '', stderr: '' };
	};

describe('throwaway database refusals', () => {
	it('says in one sentence that Docker is needed when it is not running', async () => {
		const calls: string[][] = [];
		await expect(
			makeThrowawayDatabase('rx', scope(), () => {}, { docker: stub(calls, true) })
		).rejects.toThrow('--database tool needs Docker, which is not running');
		expect(calls).toEqual([['version']]);
	});

	it('refuses port 5433 and every other forbidden port before anything is started', async () => {
		for (const port of [5433, ...FORBIDDEN_PORTS]) {
			const calls: string[][] = [];
			await expect(
				makeThrowawayDatabase('rx', scope(), () => {}, {
					docker: stub(calls),
					pickPort: async () => port
				})
			).rejects.toThrow(/may use/);
			expect(calls.every((c) => c[0] === 'version')).toBe(true);
		}
	});

	it('refuses any docker command that names a container outside the afb-checks- prefix', () => {
		expect(() => checkDockerArgs(['rm', '-f', '-v', 'postgres'])).toThrow(/afb-checks-/);
		expect(() =>
			checkDockerArgs(['rm', '-f', '-v', 'afb-checks-r1', 'agent-flow-board-db'])
		).toThrow(/afb-checks-/);
		expect(() => checkDockerArgs(['run', '-d', '--name', 'agent-flow-db', 'postgres'])).toThrow(
			/afb-checks-/
		);
		expect(() => checkDockerArgs(['run', '-d', 'postgres'])).toThrow(/afb-checks-/);
		expect(() => checkDockerArgs(['exec', 'pg', 'psql'])).toThrow(/afb-checks-/);
		expect(() => checkDockerArgs(['volume', 'rm', 'afb-checks-x'])).toThrow(
			/not one the check tool runs/
		);
		expect(() => checkDockerArgs(['compose', 'down', '-v'])).toThrow(/not one the check tool runs/);
		expect(() => checkDockerArgs([])).toThrow();
	});

	it('refuses a run that mounts a volume or publishes port 5433', () => {
		expect(() =>
			checkDockerArgs([
				'run',
				'-d',
				'--name',
				'afb-checks-r1',
				'-v',
				'pgdata:/var/lib/postgresql/data',
				'postgres'
			])
		).toThrow(/mounts/);
		expect(() =>
			checkDockerArgs([
				'run',
				'-d',
				'--name',
				'afb-checks-r1',
				'-p',
				'127.0.0.1:5433:5432',
				'postgres'
			])
		).toThrow(/never uses it/);
		expect(() =>
			checkDockerArgs(['run', '-d', '--name', 'afb-checks-r1', '-p', '5433:5432', 'postgres'])
		).toThrow(/never uses it/);
		expect(() =>
			checkDockerArgs([
				'run',
				'-d',
				'--name',
				'afb-checks-r1',
				'-p',
				'127.0.0.1:50000:5432',
				'postgres'
			])
		).not.toThrow();
		expect(() => checkDockerArgs(['rm', '-f', '-v', 'afb-checks-r1'])).not.toThrow();
	});

	it('removes only its own container, by exact name, and never runs a foreign one', async () => {
		const calls: string[][] = [];
		await removeContainer('afb-checks-r1', stub(calls));
		await removeContainer('some-other-db', stub(calls));
		expect(calls).toEqual([['rm', '-f', '-v', 'afb-checks-r1']]);
	});

	it('starts with its own name and registers the removal of that container before it waits', async () => {
		const calls: string[][] = [];
		const s = scope();
		const db = await makeThrowawayDatabase('rx', s, () => {}, {
			docker: stub(calls),
			pickPort: async () => 50123,
			readyTimeoutMs: 1_000
		});
		expect(calls[1]?.slice(0, 4)).toEqual(['run', '-d', '--name', 'afb-checks-rx']);
		expect(calls[1]).toContain('127.0.0.1:50123:5432');
		expect(db.databaseUrl).toBe(db.ownerUrl);
		expect(s.added).toEqual(['database afb-checks-rx']);
	});

	it('never picks a forbidden port', async () => {
		for (let i = 0; i < 5; i++) expect(FORBIDDEN_PORTS.has(await freePort())).toBe(false);
	});
});
