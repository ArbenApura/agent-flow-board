// RERUN-ON-CHANGE & DEV-DEFAULT `--local` TESTS (STEP A.6, AFB-20261113-1008)

// IMPORTED DEP-MODULES
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { checkMain, CHECK_USAGE } from './command.js';
import { isIgnoredWatchPath, rerunOnChange } from './rerun.js';
import type { TokenStore } from '../tokenStore.js';

// -- FUNCTIONS -- //

describe('rerun-on-change and dev defaults', () => {
	let base = '';
	let savedHome: string | undefined;

	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-rerun-')));
		savedHome = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
		mkdirSync(join(base, 'src'), { recursive: true });
	});

	afterEach(() => {
		if (savedHome === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = savedHome;
		rmSync(base, { recursive: true, force: true });
	});

	it('ignores build/VCS noise paths', () => {
		expect(isIgnoredWatchPath('node_modules/pkg/index.js')).toBe(true);
		expect(isIgnoredWatchPath('.git/index')).toBe(true);
		expect(isIgnoredWatchPath('.svelte-kit/generated/client.js')).toBe(true);
		expect(isIgnoredWatchPath('src/routes/+page.svelte')).toBe(false);
	});

	it('debounces rapid file bursts and never overlaps two runs at once', async () => {
		let listener: ((event: string, filename: string | Buffer | null) => void) | null = null;
		let concurrent = 0;
		let maxConcurrent = 0;
		const calls: { runNumber: number; changedFiles: string[] }[] = [];
		const ac = new AbortController();

		const done = rerunOnChange({
			watchPath: join(base, 'src'),
			checkKey: 'A1',
			item: 'AFB-1',
			org: 'arbenger',
			debounceMs: 25,
			signal: ac.signal,
			watchFn: (_dir, cb) => {
				listener = cb;
				return { close: () => {} };
			},
			runCheck: async (trigger) => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				calls.push(trigger);
				await new Promise((r) => setTimeout(r, 40));
				if (trigger.runNumber === 1) {
					// Emit another change while run #1 is active: should coalesce into one trailing run #2
					listener?.('change', 'src/second.ts');
					listener?.('change', 'src/third.ts');
				}
				concurrent--;
				if (trigger.runNumber === 2) ac.abort();
				return 0;
			}
		});

		listener!('change', 'node_modules/ignored.js');
		listener!('change', 'src/a.ts');
		listener!('change', 'src/a.ts');
		listener!('change', 'src/b.ts');

		const summary = await done;
		expect(maxConcurrent).toBe(1);
		expect(summary.runs).toBe(2);
		expect(calls[0]?.changedFiles).toEqual(['src/a.ts', 'src/b.ts']);
		expect(calls[1]?.changedFiles).toEqual(['src/second.ts', 'src/third.ts']);
	});

	it('keeps rerun-on-change distinct from watch in usage text and parses usage errors', async () => {
		expect(CHECK_USAGE).toContain('rerun-on-change <PATH> --check <KEY>');
		expect(CHECK_USAGE).toContain('watch [--parallel N] [--once]');
		const store: TokenStore = {
			kind: 'file',
			get: () => null,
			set: () => {},
			delete: () => {}
		};
		const logs: string[] = [];
		const code = await checkMain({
			args: ['rerun-on-change', '--check', 'D1', '--item', 'AFB-1', '--org', 'arbenger'],
			store,
			fetch: globalThis.fetch,
			personalToken: () => null,
			log: (l) => logs.push(l),
			out: () => {}
		});
		expect(code).toBe(2);
		expect(logs.join(' ')).toContain('Usage: agent-flow-board check rerun-on-change');
	});
});
