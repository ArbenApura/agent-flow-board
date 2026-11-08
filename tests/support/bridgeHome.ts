// A SETUP FILE FOR THE BRIDGE TESTS: WHEN A TEST FILE UNDER packages/bridge DOES NOT SET AFB_BRIDGE_HOME ITSELF, IT GETS A THROWAWAY FOLDER,
// SO A TEST THAT FORGETS IT NEVER TOUCHES THE REAL ~/.agent-flow-board. A TEST THAT SETS ITS OWN HOME KEEPS IT.

// -- DEP-MODULES -- //
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';

// -- STATES -- //

let made: string | null = null;
let before: string | undefined;

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
