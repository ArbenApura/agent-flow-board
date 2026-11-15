// A SETUP FILE FOR THE BRIDGE TESTS: WHEN A TEST FILE UNDER packages/bridge DOES NOT SET AFB_BRIDGE_HOME ITSELF, IT GETS A THROWAWAY FOLDER,
// SO A TEST THAT FORGETS IT NEVER TOUCHES THE REAL ~/.agent-flow-board. A TEST THAT SETS ITS OWN HOME KEEPS IT.

// IMPORTED DEP-MODULES
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';

// -- STATES -- //

let made: string | null = null;
let before: string | undefined;
let sharedSet = false;

// -- LIFECYCLES -- //

beforeAll(() => {
	const file = (expect.getState().testPath ?? '').replaceAll('\\', '/');
	if (!file.includes('/packages/bridge/')) return;
	before = process.env.AFB_BRIDGE_HOME;
	if (before) return;
	made = mkdtempSync(join(tmpdir(), 'afb-bridge-default-'));
	process.env.AFB_BRIDGE_HOME = made;
});

afterAll(() => {
	if (!made) return;
	// Only when a test left the default home in place; one that restored or set another value is not touched
	if (process.env.AFB_BRIDGE_HOME === made) delete process.env.AFB_BRIDGE_HOME;
	rmSync(made, { recursive: true, force: true });
	made = null;
});

// A bridge test that starts a real browser finds the browsers already on this machine (the shared Playwright cache) instead of downloading them into its throwaway home.
// The bridge's own browsers folder is the default for a person; PLAYWRIGHT_BROWSERS_PATH, when set, is respected (AFB-20261115-1229).
beforeAll(() => {
	// Every test file, not only the ones under packages/bridge: the vertical-slice tests in tests/ops also start the bridge's real browser
	if (process.env.PLAYWRIGHT_BROWSERS_PATH) return;
	const shared =
		process.platform === 'win32'
			? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright')
			: process.platform === 'darwin'
				? join(homedir(), 'Library', 'Caches', 'ms-playwright')
				: join(homedir(), '.cache', 'ms-playwright');
	process.env.PLAYWRIGHT_BROWSERS_PATH = shared;
	sharedSet = true;
});

afterAll(() => {
	if (!sharedSet) return;
	delete process.env.PLAYWRIGHT_BROWSERS_PATH;
	sharedSet = false;
});
