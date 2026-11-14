// TESTS OF THE OWNER APPROVAL CODES: SINGLE USE, TEN MINUTES, ONE ACTION AND TARGET, HASHED STORAGE, A TERMINAL TO MAKE ONE.

// IMPORTED DEP-MODULES
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// IMPORTED MODULES
import { APPROVAL_TTL_MS, consumeApproval, mintApproval } from './approve.js';
import { approvalsFile, checksHome } from './paths.js';

// -- FUNCTIONS -- //

describe('approve', () => {
	let base = '';
	let saved: string | undefined;
	beforeEach(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), 'afb-approve-')));
		saved = process.env.AFB_BRIDGE_HOME;
		process.env.AFB_BRIDGE_HOME = join(base, 'bridge-home');
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.AFB_BRIDGE_HOME;
		else process.env.AFB_BRIDGE_HOME = saved;
		rmSync(base, { recursive: true, force: true });
	});

	it('refuses to make a code without an interactive terminal', () => {
		expect(() => mintApproval('register', 'HAPR', { isTTY: false })).toThrow(
			/interactive terminal/
		);
	});
	it('refuses an unknown action', () => {
		expect(() => mintApproval('everything', 'HAPR', { isTTY: true })).toThrow(/not an action/);
	});
	it('makes a code that works once', () => {
		const { code } = mintApproval('register', 'HAPR', { isTTY: true });
		expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
		expect(consumeApproval('register', 'HAPR', code)).toBe(true);
		expect(consumeApproval('register', 'HAPR', code)).toBe(false);
	});
	it('accepts the code in lower case and without dashes, and the target in another case', () => {
		const { code } = mintApproval('secrets', 'HAPRM', { isTTY: true });
		expect(consumeApproval('secrets', 'haprm', code.toLowerCase().replace(/-/g, ''))).toBe(true);
	});
	it('refuses another action or another target, and keeps the code for the right one', () => {
		const { code } = mintApproval('register', 'HAPR', { isTTY: true });
		expect(consumeApproval('secrets', 'HAPR', code)).toBe(false);
		expect(consumeApproval('register', 'OTHER', code)).toBe(false);
		expect(consumeApproval('register', 'HAPR', code)).toBe(true);
	});
	it('refuses an expired code', () => {
		const now = Date.now();
		const { code } = mintApproval('pictures', 'HAPR', { isTTY: true, now });
		expect(consumeApproval('pictures', 'HAPR', code, now + APPROVAL_TTL_MS + 1)).toBe(false);
		const again = mintApproval('pictures', 'HAPR', { isTTY: true, now });
		expect(consumeApproval('pictures', 'HAPR', again.code, now + APPROVAL_TTL_MS - 1000)).toBe(
			true
		);
	});
	it('refuses garbage and a code nobody made', () => {
		mintApproval('register', 'HAPR', { isTTY: true });
		expect(consumeApproval('register', 'HAPR', '')).toBe(false);
		expect(consumeApproval('register', 'HAPR', 'AAAA-AAAA-AAAA')).toBe(false);
		expect(consumeApproval('nothing', 'HAPR', 'AAAA-AAAA-AAAA')).toBe(false);
	});
	it('a new code for the same action and target replaces the old one', () => {
		const a = mintApproval('adopt-env', 'HAPR', { isTTY: true });
		const b = mintApproval('adopt-env', 'HAPR', { isTTY: true });
		expect(consumeApproval('adopt-env', 'HAPR', a.code)).toBe(false);
		expect(consumeApproval('adopt-env', 'HAPR', b.code)).toBe(true);
	});
	it('stores only a hash, and creates the key once with owner-only permission', () => {
		const { code } = mintApproval('register', 'HAPR', { isTTY: true });
		const stored = readFileSync(approvalsFile(), 'utf8');
		expect(stored).not.toContain(code.replace(/-/g, ''));
		expect(stored).not.toContain(code);
		const key = join(checksHome(), 'approval.key');
		const first = readFileSync(key, 'utf8');
		mintApproval('register', 'OTHER', { isTTY: true });
		expect(readFileSync(key, 'utf8')).toBe(first);
		if (process.platform !== 'win32') expect(statSync(key).mode & 0o077).toBe(0);
	});
});
