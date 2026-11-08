// THE BROWSER INSTALL: ONE INSTALL AT A TIME ON A MACHINE, A NOTE WRITTEN ONLY WHEN THE RUNTIME AND THE CHROMIUM BOTH FINISHED, AND THE PINNED PLAYWRIGHT PREFERRED
// The installers are replaced, so nothing is downloaded.

// -- DEP-MODULES -- //
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// -- MODULES -- //
import {
	PLAYWRIGHT_VERSION,
	choosePlaywrightDir,
	ensureBrowser,
	type BrowserInstallIo
} from './browser.js';
import { locksDir } from './paths.js';

// -- FUNCTIONS -- //

describe('ensureBrowser (C12)', () => {
	let home = '';
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-browser-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});

	/** An install that is made of counters: the runtime and the chromium are 'there' once their installers ran. */
	function fake(opts: { failChromium?: boolean; present?: boolean } = {}) {
		const state = {
			runtime: Boolean(opts.present),
			chromium: Boolean(opts.present),
			calls: [] as string[]
		};
		const io: BrowserInstallIo = {
			pinnedDir: () => (state.runtime ? join(home, 'node_modules') : null),
			chromiumPresent: async () => state.chromium,
			installRuntime: async () => {
				state.calls.push('runtime');
				await new Promise((r) => setTimeout(r, 60));
				state.runtime = true;
			},
			installChromium: async () => {
				state.calls.push('chromium');
				await new Promise((r) => setTimeout(r, 60));
				if (opts.failChromium) throw new Error('offline');
				state.chromium = true;
			},
			notePath: () => join(home, 'checks', 'runtime', '.complete'),
			lockName: 'browser-install-test',
			pause: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20)))
		};
		return { io, state };
	}

	it('installs the runtime and the browser once, writes the note after both, and does nothing the next time', async () => {
		const { io, state } = fake();
		await ensureBrowser(() => {}, io);
		expect(state.calls).toEqual(['runtime', 'chromium']);
		expect(existsSync(io.notePath())).toBe(true);
		await ensureBrowser(() => {}, io);
		expect(state.calls).toEqual(['runtime', 'chromium']);
	});

	it('two processes at once install once: the second waits for the lock and finds the note', async () => {
		const { io, state } = fake();
		await Promise.all([ensureBrowser(() => {}, io), ensureBrowser(() => {}, io)]);
		expect(state.calls).toEqual(['runtime', 'chromium']);
		expect(readdirSync(locksDir()).filter((n) => n.includes('browser-install-test'))).toEqual([]);
	});

	it('writes no note when the browser download failed, gives the lock back, and the next call tries again', async () => {
		const { io, state } = fake({ failChromium: true });
		await expect(ensureBrowser(() => {}, io)).rejects.toThrow(/offline/);
		expect(existsSync(io.notePath())).toBe(false);
		expect(readdirSync(locksDir()).filter((n) => n.includes('browser-install-test'))).toEqual([]);
		// The runtime stays; only the browser is done again
		const again = fake();
		again.state.runtime = true;
		await ensureBrowser(() => {}, again.io);
		expect(again.state.calls).toEqual(['chromium']);
		expect(state.calls).toEqual(['runtime', 'chromium']);
	});

	it('an install that was already whole but has no note (an older version of the tool) gets its note without a download', async () => {
		const { io, state } = fake({ present: true });
		await ensureBrowser(() => {}, io);
		expect(state.calls).toEqual([]);
		expect(existsSync(io.notePath())).toBe(true);
	});

	it('gives up with one plain sentence when another install keeps the lock for too long', async () => {
		const { io } = fake();
		const { acquireLock } = await import('./lock.js');
		const held = acquireLock(io.lockName, { staleMs: 60_000 });
		try {
			await expect(ensureBrowser(() => {}, io, { waitMs: 100, staleMs: 60_000 })).rejects.toThrow(
				/installing the browser for a long time/
			);
		} finally {
			held?.release();
		}
	});
});

describe('choosePlaywrightDir (C12)', () => {
	const versions: Record<string, string> = {
		'/bridge/nm': '1.40.0',
		'/runtime/nm': PLAYWRIGHT_VERSION,
		'/bridge/pinned': PLAYWRIGHT_VERSION,
		'/runtime/old': '1.30.0'
	};
	const versionOf = (d: string) => versions[d] ?? '';

	it('prefers the runtime copy when the one beside the bridge is not the pinned version', () => {
		expect(choosePlaywrightDir('/bridge/nm', '/runtime/nm', versionOf)).toBe('/runtime/nm');
	});
	it('prefers the one beside the bridge when it is the pinned version', () => {
		expect(choosePlaywrightDir('/bridge/pinned', '/runtime/nm', versionOf)).toBe('/bridge/pinned');
	});
	it('falls back to whatever exists so the version check can say what is wrong', () => {
		expect(choosePlaywrightDir('/bridge/nm', '/runtime/old', versionOf)).toBe('/bridge/nm');
		expect(choosePlaywrightDir(null, '/runtime/old', versionOf)).toBe('/runtime/old');
		expect(choosePlaywrightDir(null, null, versionOf)).toBeNull();
	});
});
