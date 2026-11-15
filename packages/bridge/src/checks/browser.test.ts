// THE BROWSER INSTALL: ONE INSTALL AT A TIME ON A MACHINE, A NOTE WRITTEN ONLY WHEN THE RUNTIME AND THE CHROMIUM BOTH FINISHED, AND THE PINNED PLAYWRIGHT PREFERRED
// The installers are replaced, so nothing is downloaded.

// IMPORTED DEP-MODULES
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import {
	PLAYWRIGHT_VERSION,
	activeBrowsersDir,
	browsersDir,
	choosePlaywrightDir,
	confirmBrowserDownload,
	describeInstallFailure,
	downloadNote,
	ensureBrowser,
	removeOwnFolder,
	type BrowserInstallIo
} from './browser.js';
import { checksHome, locksDir } from './paths.js';

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

// -- AFB-20261115-1229: THE BRIDGE'S OWN BROWSER FOLDER, THE ONE YES, AND WHAT A FAILED INSTALL SAYS -- //

describe('the bridge keeps its own browser (AFB-20261115-1229)', () => {
	let home = '';
	let before: string | undefined;
	beforeEach(() => {
		before = process.env.AFB_BRIDGE_HOME;
		home = mkdtempSync(join(tmpdir(), 'afb-browser-own-'));
		process.env.AFB_BRIDGE_HOME = home;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = before;
		rmSync(home, { recursive: true, force: true });
	});

	it('the browsers live inside the bridge home, so a project’s own Playwright cache is never the one used', () => {
		expect(browsersDir()).toBe(join(checksHome(), 'browsers'));
		expect(browsersDir().startsWith(home)).toBe(true);
	});

	it('the download note names the size, the source and the folder before anything is downloaded', () => {
		const note = downloadNote();
		expect(note).toMatch(/about 320 MB/);
		expect(note).toMatch(/Chromium about 200 MB plus its headless shell about 120 MB/);
		expect(note).toMatch(/Playwright's download servers/);
		expect(note).toContain(activeBrowsersDir());
	});

	it('removing the old browser and runtime takes only those two folders: a foreign sibling survives', () => {
		const foreign = join(checksHome(), 'ms-playwright');
		const scripts = join(checksHome(), 'scripts');
		for (const dir of [browsersDir(), join(checksHome(), 'runtime'), foreign, scripts]) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'keep.txt'), 'x');
		}
		expect(removeOwnFolder('browsers')).toBe(true);
		expect(removeOwnFolder('runtime')).toBe(true);
		expect(existsSync(browsersDir())).toBe(false);
		expect(existsSync(join(checksHome(), 'runtime'))).toBe(false);
		expect(existsSync(join(foreign, 'keep.txt'))).toBe(true);
		expect(existsSync(join(scripts, 'keep.txt'))).toBe(true);
		// Nothing there any more: nothing is removed and nothing throws
		expect(removeOwnFolder('browsers')).toBe(false);
	});

	it('a browsers folder that is really a link to another place is left alone', () => {
		const outside = mkdtempSync(join(tmpdir(), 'afb-outside-'));
		try {
			writeFileSync(join(outside, 'keep.txt'), 'x');
			mkdirSync(checksHome(), { recursive: true });
			try {
				symlinkSync(outside, browsersDir(), 'junction');
			} catch {
				// Making a link needs a privilege on some systems: nothing to prove there
				return;
			}
			expect(removeOwnFolder('browsers')).toBe(false);
			expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
		} finally {
			rmSync(browsersDir(), { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it('one yes covers the whole download: --yes, and nothing is downloaded without it (the bridge never reads a terminal)', () => {
		const said: string[] = [];
		expect(confirmBrowserDownload(true, (l) => said.push(l))).toBe(true);
		// The size and the source are said first, whatever the answer
		expect(said.join('\n')).toMatch(/about 320 MB/);
		expect(confirmBrowserDownload(undefined, () => undefined)).toBe(false);
	});

	it('a failed install names the cause in one line: disk full, permissions, proxy, offline', () => {
		expect(describeInstallFailure('npm ERR! code ENOSPC: no space left on device')).toMatch(
			/disk is full/
		);
		expect(describeInstallFailure('EPERM: operation not permitted, rename')).toMatch(
			/security program/
		);
		expect(describeInstallFailure('Error: 407 Proxy Authentication Required')).toMatch(/proxy/);
		expect(describeInstallFailure('getaddrinfo ENOTFOUND cdn.playwright.dev')).toMatch(/offline/);
		expect(describeInstallFailure('something odd')).toMatch(/last lines/);
	});

	it('a manifest only folder is not whole: the runtime is there, the browser is not, so only the browser is downloaded and the note comes after', async () => {
		const calls: string[] = [];
		let chromium = false;
		const note = join(checksHome(), 'runtime', '.complete');
		const io: BrowserInstallIo = {
			pinnedDir: () => join(home, 'node_modules'),
			chromiumPresent: async () => chromium,
			installRuntime: async () => void calls.push('runtime'),
			installChromium: async () => {
				calls.push('chromium');
				chromium = true;
			},
			notePath: () => note,
			lockName: 'browser-install-own',
			pause: async () => undefined
		};
		mkdirSync(join(checksHome(), 'runtime'), { recursive: true });
		writeFileSync(join(checksHome(), 'runtime', 'package.json'), '{"private":true}');
		await ensureBrowser(() => undefined, io);
		expect(calls).toEqual(['chromium']);
		expect(existsSync(note)).toBe(true);
		// Ready now: the next check (or the next setup) downloads nothing
		await ensureBrowser(() => undefined, io);
		expect(calls).toEqual(['chromium']);
	});
});
